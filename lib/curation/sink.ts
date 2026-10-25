import { readAuthoredSeries } from '../catalog/working-layer';
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
import { EventUnusableError, readEvent, readRulesFile, withCurationLock, writeEvent } from './repository';
import { loadRules, suggestForNew, type LoadedRules } from './suggest';

/**
 * The watcher's curation sink: each of #10's committed facts opens or
 * updates one inbox event. It writes only under `curation/`. It reads the
 * registry for the photo's public facts and the working layer's series
 * (through lib/catalog/working-layer.ts) for the suggestions, and never
 * imports the authored writer or the sequence operations, so ingestion never
 * authors anything: a new photograph waits in the inbox until the curator
 * approves it. Delivery is at least once, so a fact already folded into its
 * event writes nothing.
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
    } catch {
        rules = { state: 'invalid', reason: 'it is not valid JSON' };
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

export function createCurationSink(options: CurationSinkOptions = {}): FactSink {
    const { clock = Date.now, logger = console, waitMs = SINK_WAIT_MS } = options;
    return async (facts) => {
        const relevant = facts.flatMap((fact) => {
            const type = EVENT_TYPE_FOR_FACT[fact.type];
            return type === null ? [] : [{ fact, type }];
        });
        if (relevant.length === 0) return;
        const status = dataRootStatus({ versioned: true, ...(options.root === undefined ? {} : { root: options.root }) });
        if (status.state !== 'ready' || status.root === null) throw new Error(`The data root is ${status.state}, so the curation inbox can't be written.`);
        const root = status.root;

        const registry = await readRegistry(root).catch(() => null);
        const context = relevant.some(({ type }) => type === 'new') ? await suggestContext(root, logger) : null;
        const producedAt = new Date(clock()).toISOString();

        let opened = 0;
        let updated = 0;
        await withCurationLock(root, { waitMs }, async (hold) => {
            for (const { fact, type } of relevant) {
                hold.signal.throwIfAborted();
                const id = eventIdOf(eventKey(type, fact));
                let existing: CurationEvent | null;
                try {
                    existing = await readEvent(root, id);
                } catch (error) {
                    if (!(error instanceof EventUnusableError)) throw error;
                    logger.error(`[curation] ${error.message}. This ${type} fact is not recorded until it is fixed.`);
                    continue;
                }
                if (existing === null) {
                    const suggestions: Suggestions = type === 'new' && context
                        ? suggestForNew({ ...context, sourcePath: fact.path, folder: fact.folder, capturedDate: derivedFactsOf(fact, registry).capturedDate ?? null, producedAt })
                        : { series: null, placement: null };
                    await writeEvent(root, newEvent(fact, type, registry, suggestions), 0, hold);
                    opened++;
                    continue;
                }
                if (existing.factIds.includes(fact.factId)) continue;
                // The same evidence again. The item stays as the curator left it; only when it was last seen moves.
                const next: CurationEvent = {
                    ...existing,
                    lastObservedAt: fact.observedAt > existing.lastObservedAt ? fact.observedAt : existing.lastObservedAt,
                    factIds: [...existing.factIds, fact.factId].slice(-KEPT_FACT_IDS),
                };
                await writeEvent(root, next, existing.version, hold);
                updated++;
            }
        });
        if (opened > 0 || updated > 0) logger.log(`[curation] Inbox: opened ${opened}, updated ${updated}.`);
    };
}
