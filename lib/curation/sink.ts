import { readActivePointer, readAuthoredSeries } from '../catalog/working-layer';
import { ASSET_REVISION_RE, PHOTO_ID_RE } from '../identity/ids';
import type { FactSink } from '../identity/pass';
import { readRegistry } from '../identity/registry';
import type { IdentityFact, Registry } from '../identity/types';
import { dataRootStatus } from '../storage/config';
import {
    CURATION_SCHEMA_VERSION,
    EVENT_TYPE_FOR_FACT,
    eventIdOf,
    eventKey,
    fingerprintOf,
    KEPT_FACT_IDS,
    type CurationEvent,
    type CurationEventType,
    type DerivedFacts,
    type Suggestions,
} from './events';
import { photoHolders, type ReferenceCache } from './holders';
import { EventUnusableError, InvalidEventError, listEvents, readEvent, readRulesFile, RulesFileError, withCurationLock, writeEvent } from './repository';
import { loadRules, suggestForNew, type LoadedRules } from './suggest';

/**
 * The watcher's curation sink: each of #10's committed facts opens or
 * updates one inbox event. It writes only under `curation/`. It reads the
 * registry for the photo's public facts, the working layer's series
 * (through lib/catalog/working-layer.ts) for the suggestions, and, to decide
 * the one reopen rule, the active pointer and what references() reads: the
 * revisions, the candidates, and the working layer. It never imports the
 * authored writer or the sequence operations, so ingestion never authors
 * anything: a new photograph waits in the inbox until the curator approves
 * it. Delivery is at least once, so a fact already folded into its event
 * writes nothing. A fact it can't use is skipped; an I/O or lock error fails
 * the delivery, so the pass delivers the facts again.
 */

type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

export interface CurationSinkOptions {
    /** Defaults to the data root at each delivery. */
    root?: string;
    clock?: () => number;
    logger?: Logger;
    /** How long to wait for the curation lock. A busy lock fails the delivery, and the facts stay pending for the next pass. */
    waitMs?: number;
}

/** How long the sink waits for the curation lock, inside the pass's registry hold. */
export const SINK_WAIT_MS = 5_000;

function derivedFactsOf(fact: IdentityFact, registry: Registry | null): DerivedFacts {
    const revision = fact.photoId === null ? undefined : registry?.photos[fact.photoId]?.revisions[fact.assetRevision];
    return {
        factType: fact.type,
        sourcePath: fact.path,
        folder: fact.folder,
        ...(fact.fromPath === undefined ? {} : { fromPath: fact.fromPath }),
        ...(fact.candidates === undefined ? {} : { candidates: [...fact.candidates] }),
        ...(fact.duplicateOf === undefined ? {} : { duplicateOf: fact.duplicateOf }),
        ...(fact.samePathAs === undefined ? {} : { samePathAs: fact.samePathAs }),
        ...(fact.revert === undefined ? {} : { revert: fact.revert }),
        ...(fact.reason === undefined ? {} : { failure: fact.reason }),
        // Only #10's public tier. GPS, the full timestamp, artist, and copyright stay in the registry.
        ...(revision ? { capturedDate: revision.derived.capturedDate?.value ?? null, width: revision.width, height: revision.height, sourceFormat: revision.sourceFormat } : {}),
    };
}

interface SuggestContext {
    rules: LoadedRules;
    knownSeries: Set<string>;
    seriesTitles: Map<string, string>;
}

async function suggestContext(root: string, logger: Logger): Promise<SuggestContext> {
    let rules: LoadedRules;
    try {
        rules = loadRules(await readRulesFile(root));
    } catch (error) {
        if (!(error instanceof RulesFileError)) throw error;
        rules = { state: 'invalid', reason: error.message };
    }
    if (rules.state === 'invalid') logger.warn(`[curation] curation/rules.json is not valid (${rules.reason}), so no series is suggested.`);
    const { series } = await readAuthoredSeries(root);
    return {
        rules,
        knownSeries: new Set(series.map((entry) => entry.id)),
        seriesTitles: new Map(series.filter((entry) => entry.title).map((entry) => [entry.id, entry.title])),
    };
}

function newEvent(fact: IdentityFact, type: CurationEventType, registry: Registry | null, suggestions: Suggestions): CurationEvent {
    const key = eventKey(type, fact);
    return {
        schemaVersion: CURATION_SCHEMA_VERSION,
        version: 1,
        id: eventIdOf(key),
        key,
        type,
        photoId: fact.photoId,
        sourceFingerprint: fingerprintOf(fact.assetRevision),
        assetRevision: fact.assetRevision,
        observedAt: fact.observedAt,
        lastObservedAt: fact.observedAt,
        factIds: [fact.factId],
        status: type === 'processing-failure' ? 'failed' : 'open',
        derivedFacts: derivedFactsOf(fact, registry),
        suggestions,
        edits: null,
        decisions: [],
        reviewedAt: null,
        reviewedBy: null,
    };
}

/** Why a fact can't become an event, or null when it can. Facts come from a registry another build may have written. */
function shapeProblem(fact: IdentityFact): string | null {
    if (typeof fact.factId !== 'string' || fact.factId.length === 0) return 'it has no factId';
    if (typeof fact.assetRevision !== 'string' || !ASSET_REVISION_RE.test(fact.assetRevision)) return 'its assetRevision is not one';
    if (fact.photoId !== null && (typeof fact.photoId !== 'string' || !PHOTO_ID_RE.test(fact.photoId))) return 'its photoId is not one';
    if (typeof fact.path !== 'string' || typeof fact.folder !== 'string' || typeof fact.observedAt !== 'string') return 'it lacks its path, folder, or observedAt';
    return null;
}

const STILL_OPEN = new Set(['open', 'deferred', 'failed']);

export function createCurationSink(options: CurationSinkOptions = {}): FactSink {
    const { clock = Date.now, logger = console, waitMs = SINK_WAIT_MS } = options;
    /** A fact this sink can't use is logged by its factId and counted as delivered, so it never holds the others back. */
    const skip = (fact: { factId?: unknown }, why: string) => logger.warn(`[curation] Skipped fact ${JSON.stringify(String(fact.factId))}: ${why}. It is not delivered again.`);

    return async (facts) => {
        const relevant: { fact: IdentityFact; type: CurationEventType }[] = [];
        const renames: IdentityFact[] = [];
        for (const fact of facts) {
            const type = Object.hasOwn(EVENT_TYPE_FOR_FACT, fact.type) ? EVENT_TYPE_FOR_FACT[fact.type] : undefined;
            if (type === undefined) {
                skip(fact, 'its type is not one this build knows');
                continue;
            }
            const problem = shapeProblem(fact);
            if (problem !== null) {
                skip(fact, problem);
                continue;
            }
            if (type !== null) relevant.push({ fact, type });
            // A rename of a file with no photo ID matches no item by identity, so it changes nothing.
            else if (fact.photoId !== null) renames.push(fact);
        }
        if (relevant.length === 0 && renames.length === 0) return;
        const status = dataRootStatus({ versioned: true, ...(options.root === undefined ? {} : { root: options.root }) });
        if (status.state !== 'ready' || status.root === null) throw new Error(`The data root is ${status.state}, so the curation inbox can't be written.`);
        const root = status.root;

        const registry = await readRegistry(root).catch(() => null);
        const context = relevant.some(({ type }) => type === 'new') ? await suggestContext(root, logger) : null;
        const producedAt = new Date(clock()).toISOString();
        const referenceCache: ReferenceCache = {};

        let opened = 0;
        let updated = 0;
        let reopened = 0;
        await withCurationLock(root, { waitMs }, async (hold) => {
            /** Write `event`, or skip the fact when it doesn't make a valid one. Only I/O and the lock fail the delivery. */
            const write = async (fact: IdentityFact, event: CurationEvent, expected: number): Promise<boolean> => {
                hold.signal.throwIfAborted();
                try {
                    await writeEvent(root, event, expected, hold);
                    return true;
                } catch (error) {
                    if (!(error instanceof InvalidEventError)) throw error;
                    skip(fact, 'it does not make a valid inbox event');
                    return false;
                }
            };

            for (const { fact, type } of relevant) {
                let id: string;
                let fresh: CurationEvent;
                try {
                    id = eventIdOf(eventKey(type, fact));
                    const suggestions: Suggestions = type === 'new' && context
                        ? suggestForNew({ ...context, sourcePath: fact.path, folder: fact.folder, capturedDate: derivedFactsOf(fact, registry).capturedDate ?? null, producedAt })
                        : { series: null, placement: null };
                    fresh = newEvent(fact, type, registry, suggestions);
                } catch {
                    skip(fact, 'it does not make a valid inbox event');
                    continue;
                }
                let existing: CurationEvent | null;
                try {
                    existing = await readEvent(root, id);
                } catch (error) {
                    // An errno is I/O: fail the delivery so the fact comes again. Only a damaged event is skipped.
                    if (!(error instanceof EventUnusableError) || error.problem.reason === 'unreadable') throw error;
                    logger.error(`[curation] ${error.message}. This ${type} fact is skipped and not delivered again. Fix or remove that event's folder.`);
                    continue;
                }
                if (existing === null) {
                    if (await write(fact, fresh, 0)) opened++;
                    continue;
                }
                if (existing.factIds.includes(fact.factId)) continue;
                // The same evidence again. The item stays as the curator left it; only when it was last seen moves.
                let next: CurationEvent = {
                    ...existing,
                    lastObservedAt: fact.observedAt > existing.lastObservedAt ? fact.observedAt : existing.lastObservedAt,
                    factIds: [...existing.factIds, fact.factId].slice(-KEPT_FACT_IDS),
                };
                // One reopen rule only: a source missing again while something shows the photo can't stay silenced.
                if (type === 'missing' && existing.photoId !== null && !STILL_OPEN.has(existing.status)) {
                    const found = await photoHolders(root, existing.photoId, referenceCache);
                    const holders = 'holders' in found ? found.holders : null;
                    if (holders === null || holders.length > 0) {
                        const active = await readActivePointer(root).then((pointer) => pointer?.revisionId ?? null, () => null);
                        const reason = holders === null
                            ? "The source went missing again, and the data root can't show whether anything still references the photograph."
                            : `The source went missing again while ${holders.join(' and ')} ${holders.length === 1 ? 'references' : 'reference'} the photograph.`;
                        next = { ...next, status: 'open', decisions: [...existing.decisions, { action: 'reopen', at: producedAt, by: 'watcher', baseRevisionId: active, reason }] };
                    }
                }
                if (await write(fact, next, existing.version)) {
                    if (next.status !== existing.status) reopened++;
                    else updated++;
                }
            }

            if (renames.length > 0) {
                // A rename opens no item, but the photograph's open items should name the path it has now.
                const { events } = await listEvents(root);
                for (const fact of renames) {
                    for (const event of events) {
                        if (event.photoId !== fact.photoId || !STILL_OPEN.has(event.status) || event.derivedFacts.sourcePath === fact.path) continue;
                        const current = await readEvent(root, event.id).catch((error: unknown) => {
                            if (error instanceof EventUnusableError && error.problem.reason !== 'unreadable') return null;
                            throw error;
                        });
                        if (current === null || current.derivedFacts.sourcePath === fact.path) continue;
                        if (await write(fact, { ...current, derivedFacts: { ...current.derivedFacts, sourcePath: fact.path, folder: fact.folder } }, current.version)) updated++;
                    }
                }
            }
        });
        if (opened > 0 || updated > 0 || reopened > 0) logger.log(`[curation] Inbox: opened ${opened}, updated ${updated}, reopened ${reopened}.`);
    };
}
