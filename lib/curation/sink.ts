import { readActivePointer, readAuthoredRecord, readAuthoredSeries, RecordUnusableError } from '../catalog/working-layer';
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
        // A replacement may move a new item to new bytes, and its suggestions with it.
        const context = relevant.some(({ type }) => type === 'new' || type === 'replacement') ? await suggestContext(root, logger) : null;
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
                    if (error instanceof EventUnusableError && error.problem.reason !== 'unreadable') {
                        logger.error(`[curation] ${error.message}. This fact is skipped and not delivered again. Fix that event's folder.`);
                        return false;
                    }
                    if (!(error instanceof InvalidEventError)) throw error;
                    skip(fact, 'it does not make a valid inbox event');
                    return false;
                }
            };

            /** Whether the photo has a photo record. A damaged one counts as one; I/O fails the delivery. */
            const hasPhotoRecord = async (photoId: string): Promise<boolean> => {
                try {
                    return (await readAuthoredRecord(root, 'photo', photoId)) !== null;
                } catch (error) {
                    if (error instanceof RecordUnusableError && error.problem.reason !== 'unreadable') return true;
                    throw error;
                }
            };
            const readOrSkip = (eventId: string) => readEvent(root, eventId).catch((error: unknown) => {
                if (error instanceof EventUnusableError && error.problem.reason !== 'unreadable') return null;
                throw error;
            });
            /**
             * The items of one type for one photo, from one listing taken when a fold first needs it and kept current
             * as this delivery opens more. An item the listing couldn't read for an errno fails the delivery, since
             * it may be the one a fact belongs to; a damaged one is passed over.
             */
            let byPhoto: Map<string, string[]> | null = null;
            const itemsOf = async (type: CurationEventType, photoId: string): Promise<string[]> => {
                if (byPhoto === null) {
                    const { events, problems } = await listEvents(root);
                    const unreadable = problems.find((problem) => problem.reason === 'unreadable');
                    if (unreadable) throw new Error(`The inbox item ${unreadable.id} can't be read (${unreadable.message}), so this delivery waits for the next pass.`);
                    byPhoto = new Map();
                    for (const event of events) {
                        if (event.photoId !== null) byPhoto.set(`${event.type}|${event.photoId}`, [...(byPhoto.get(`${event.type}|${event.photoId}`) ?? []), event.id]);
                    }
                }
                return byPhoto.get(`${type}|${photoId}`) ?? [];
            };
            const noteOpened = (event: CurationEvent) => {
                if (byPhoto !== null && event.photoId !== null) {
                    const known: Map<string, string[]> = byPhoto;
                    known.set(`${event.type}|${event.photoId}`, [...(known.get(`${event.type}|${event.photoId}`) ?? []), event.id]);
                }
            };
            /** The readable items of `type` for the photo, newest state, and whether one already holds `factId`. */
            const loadItems = async (type: CurationEventType, photoId: string, factId: string) => {
                const items: CurationEvent[] = [];
                for (const eventId of await itemsOf(type, photoId)) {
                    const current = await readOrSkip(eventId);
                    if (current !== null && current.type === type) items.push(current);
                }
                return { items, seen: items.some((item) => item.factIds.includes(factId)) };
            };
            const pending = (event: CurationEvent) => event.status === 'open' || event.status === 'deferred';

            /**
             * New bytes for a photograph no one has approved yet fold into its open or deferred new item: the item
             * moves to them, with suggestions for them, and its version goes up, so an approval reviewed against the
             * older bytes is stale. No replacement item opens beside it. Once a photo record exists, only a confirm
             * moves the photo, so the fact opens a replacement item as usual. The record is read only when there is
             * an item to fold into. Returns whether the fact is handled.
             */
            const foldIntoNew = async (fact: IdentityFact): Promise<boolean> => {
                const photoId = fact.photoId as string;
                const { items, seen } = await loadItems('new', photoId, fact.factId);
                if (seen) return true;
                const open = items.filter(pending);
                if (open.length === 0 || await hasPhotoRecord(photoId)) return false;
                for (const current of open) {
                    if (current.assetRevision === fact.assetRevision) continue;
                    const derivedFacts = { ...derivedFactsOf(fact, registry), factType: current.derivedFacts.factType };
                    const moved: CurationEvent = {
                        ...current,
                        assetRevision: fact.assetRevision,
                        sourceFingerprint: fingerprintOf(fact.assetRevision),
                        derivedFacts,
                        suggestions: context ? suggestForNew({ ...context, sourcePath: fact.path, folder: fact.folder, capturedDate: derivedFacts.capturedDate ?? null, producedAt }) : current.suggestions,
                        lastObservedAt: fact.observedAt > current.lastObservedAt ? fact.observedAt : current.lastObservedAt,
                        factIds: [...current.factIds, fact.factId].slice(-KEPT_FACT_IDS),
                    };
                    if (await write(fact, moved, current.version)) updated++;
                }
                return true;
            };

            /**
             * The same bytes back for a photograph whose missing item is open or deferred close that item, saying
             * so, and open no reappeared item: there is nothing left to judge. Other bytes open what they always
             * did. Returns whether the fact is handled.
             */
            const closeMissing = async (fact: IdentityFact): Promise<boolean> => {
                const { items, seen } = await loadItems('missing', fact.photoId as string, fact.factId);
                if (seen) return true;
                const open = items.filter((item) => pending(item) && item.assetRevision === fact.assetRevision);
                if (open.length === 0) return false;
                const active = await readActivePointer(root).then((pointer) => pointer?.revisionId ?? null, () => null);
                for (const current of open) {
                    const closed: CurationEvent = {
                        ...current,
                        status: 'dismissed',
                        lastObservedAt: fact.observedAt > current.lastObservedAt ? fact.observedAt : current.lastObservedAt,
                        factIds: [...current.factIds, fact.factId].slice(-KEPT_FACT_IDS),
                        decisions: [...current.decisions, { action: 'dismiss', at: producedAt, by: 'watcher', baseRevisionId: active, reason: `The same bytes came back at ${fact.path}, so nothing is missing.` }],
                        reviewedAt: producedAt,
                        reviewedBy: 'watcher',
                    };
                    if (await write(fact, closed, current.version)) updated++;
                }
                return true;
            };

            for (const { fact, type } of relevant) {
                if (type === 'replacement' && fact.photoId !== null && await foldIntoNew(fact)) continue;
                if (type === 'reappeared' && fact.photoId !== null && await closeMissing(fact)) continue;
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
                    if (await write(fact, fresh, 0)) {
                        opened++;
                        noteOpened(fresh);
                    }
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
