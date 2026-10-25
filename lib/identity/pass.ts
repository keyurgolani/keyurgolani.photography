import { randomUUID } from 'node:crypto';
import { dataRootStatus, libraryRoot, type DataRootState } from '../storage/config';
import { UnsupportedSchemaError, type VersionedWriteHooks } from '../storage/document';
import { LockTimeoutError, withLock, type LockRecord } from '../storage/lock';
import { readPendingDecisions, settleDecisions, type DecisionFile, type DecisionOutcome } from './decisions';
import { namedUuid, sha256, type Hasher } from './ids';
import { inspectEntry, type Inspection } from './inspect';
import { currentProfileId } from './profile';
import { isStillChanging, reconcile, type FactDraft, type ReconcileReport } from './reconcile';
import { emptyStatCache, readRegistry, readStatCache, writeRegistry, writeStatCache, type StatCache, type StatCacheEntry } from './registry';
import { scanLibrary, type LibraryScan } from './scan';
import type { DerivativeJob, IdentityFact, RecordedDecision, Registry } from './types';

type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

/** Injectable inputs, so tests control digests, IDs, and time. */
export interface PassDeps {
    hasher?: Hasher;
    idGen?: () => string;
    clock?: () => number;
    profileId?: string;
    logger?: Logger;
}

/** Receives committed facts. Sinks see a fact again after a crash, so they dedupe by factId. */
export type FactSink = (facts: readonly IdentityFact[]) => void | Promise<void>;

/** A sink that writes one JSON line per fact. */
export function jsonLogSink(logger: Pick<Console, 'log'> = console): FactSink {
    return (facts) => {
        for (const fact of facts) logger.log(JSON.stringify({ event: 'identity-fact', ...fact }));
    };
}

export interface ObservedLibrary {
    scan: LibraryScan;
    /** What each file read as this pass, by path. Files too fresh to read are absent. */
    inspections: ReadonlyMap<string, Inspection>;
    registry: Registry;
    /** Facts to commit, with repeats of already-reported failures removed. */
    facts: FactDraft[];
    jobs: DerivativeJob[];
    report: ReconcileReport;
    retryAfterMs: number | null;
    statCache: StatCache;
    /** What became of each decision, in order. */
    decisions: DecisionOutcome[];
}

/**
 * Reports made once per version of a file, an unsupported file and a digest
 * collision: they change no registry state, so only the stat cache remembers
 * that they were made.
 */
function reportedOncePerVersion(fact: Pick<FactDraft, 'type' | 'reason'>): boolean {
    return fact.type === 'processing-failed' && fact.reason !== 'undecodable';
}

/**
 * The stat cache is written after the registry, so a crash between the two,
 * or a cache that can't be written, makes one of those reports again. Its
 * factId comes from the report itself, so the repeat carries the same one and
 * sinks drop it. Every other fact gets a fresh ID.
 */
function factIdFor(draft: FactDraft, idGen: () => string): string {
    return reportedOncePerVersion(draft) ? namedUuid(`${draft.key}\0${draft.path}\0${draft.reason ?? ''}`) : idGen();
}

type Signature = Pick<StatCacheEntry, 'size' | 'mtimeMs' | 'ctimeMs' | 'ino'>;

/** Whether two stats describe the same version of a file, by the signature the stat cache keys on. */
function sameSignature(a: Signature, b: Signature): boolean {
    return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;
}

/**
 * `latest`'s readings with `committed`'s record of reported failures: what
 * observeLibrary() should start from when it observes again without having
 * committed anything, as the dry run does while it waits for changing files.
 * Each file keeps the failures `committed` recorded for that same version of
 * it, and none for a version it never saw.
 */
export function withReportedFailures(latest: StatCache, committed: StatCache): StatCache {
    const entries: Record<string, StatCacheEntry> = {};
    for (const [relativePath, entry] of Object.entries(latest.entries)) {
        const before = committed.entries[relativePath];
        entries[relativePath] = { ...entry, emitted: before && sameSignature(before, entry) ? [...before.emitted] : [] };
    }
    return { ...latest, entries };
}

/**
 * Scan the library, read the files whose size, mtime, ctime, or inode
 * changed since the stat cache saw them, and reconcile. Writes nothing.
 */
export async function observeLibrary(
    { root, registry, statCache = emptyStatCache(), deps = {}, decisions = [] }: { root: string; registry: Registry; statCache?: StatCache; deps?: PassDeps; decisions?: readonly DecisionFile[] },
): Promise<ObservedLibrary> {
    const { hasher = sha256, idGen = randomUUID, clock = Date.now } = deps;
    const profileId = deps.profileId ?? currentProfileId();
    const scan = await scanLibrary(root, { clock });

    const inspections = new Map<string, Inspection>();
    const entries: Record<string, StatCacheEntry> = {};
    for (const entry of scan.entries) {
        const cached = statCache.entries[entry.path];
        const unchanged = cached !== undefined && sameSignature(cached, entry) && (cached.inspection.kind === 'image') === (entry.kind === 'source');
        if (isStillChanging(entry, scan.observedAt)) {
            // Too fresh to read. reconcile() skips it, and its cache entry carries over.
            if (unchanged) entries[entry.path] = cached;
            continue;
        }
        const inspection = unchanged ? cached.inspection : await inspectEntry(root, entry, { hasher });
        inspections.set(entry.path, inspection);
        if (inspection.kind === 'image' || inspection.kind === 'unsupported') {
            entries[entry.path] = {
                size: entry.size,
                mtimeMs: entry.mtimeMs,
                ctimeMs: entry.ctimeMs,
                ino: entry.ino,
                inspection,
                emitted: unchanged ? [...cached.emitted] : [],
            };
        }
    }

    const result = reconcile(scan, registry, (entry) => inspections.get(entry.path), { idGen, profileId, decisions });

    // An unsupported file or a digest collision changes no registry state, so report it once per version of the file.
    const facts = result.facts.filter((fact) => {
        if (!reportedOncePerVersion(fact)) return true;
        const entry = entries[fact.path];
        if (!entry) return true;
        if (entry.emitted.includes(fact.key)) return false;
        entry.emitted.push(fact.key);
        return true;
    });

    return {
        scan,
        inspections,
        registry: result.registry,
        facts,
        jobs: result.jobs,
        report: result.report,
        retryAfterMs: result.retryAfterMs,
        statCache: { schemaVersion: statCache.schemaVersion, version: statCache.version + 1, entries },
        decisions: result.decisions,
    };
}

/** Test hooks for crashes at each step after the registry write. */
export interface PassFaults {
    /** After reconciling, before the registry write. A test can write the registry here as a foreign writer. */
    beforeRegistryWrite?(): void | Promise<void>;
    registryWrite?: VersionedWriteHooks;
    /** After the registry and stat cache are written, before decision files move to applied/ or rejected/. */
    beforeSettle?(): void | Promise<void>;
    /** After the registry and stat cache are written, before any fact is delivered. */
    beforeDelivery?(): void | Promise<void>;
    /** After delivery, before delivered facts are cleared. */
    beforeClear?(): void | Promise<void>;
}

export interface PassOptions extends PassDeps {
    sinks?: FactSink[];
    /**
     * Clear facts from `pendingFacts` once every sink has them. Only the
     * watcher does this. CLI passes deliver to the log and leave the facts for
     * the watcher, so every sink still gets them.
     */
    clearDelivered?: boolean;
    lock?: { waitMs?: number; leaseMs?: number };
    faults?: PassFaults;
}

export type PassOutcome =
    | {
        status: 'committed';
        registry: Registry;
        /** Facts this pass committed. */
        facts: IdentityFact[];
        /** Everything delivered this pass, leftovers from earlier passes first. */
        delivered: IdentityFact[];
        jobs: DerivativeJob[];
        report: ReconcileReport;
        retryAfterMs: number | null;
        /** What became of each decision file, in order. */
        decisions: DecisionOutcome[];
    }
    | { status: 'skipped'; reason: 'data-root'; state: DataRootState; detail?: string }
    | { status: 'skipped'; reason: 'locked'; holder: LockRecord | null };

/**
 * Split the waiting decision files into those to apply now and those an
 * earlier registry write already applied or rejected, which a crash kept
 * from being filed. Returns the outcomes in file order, given what the new
 * ones came to, and the record the next registry write carries: every
 * waiting decision that is applied or rejected now, until its file moves.
 */
function replayDecisions(files: readonly DecisionFile[], recorded: Readonly<Record<string, RecordedDecision>>) {
    const isRecorded = (file: DecisionFile) => file.decision !== null && Object.hasOwn(recorded, file.decision.decisionId);
    const fresh = files.filter((file) => !isRecorded(file));
    const settle = (outcomesOfFresh: readonly DecisionOutcome[]) => {
        const byName = new Map(outcomesOfFresh.map((outcome) => [outcome.name, outcome]));
        const outcomes: DecisionOutcome[] = [];
        const decided: Record<string, RecordedDecision> = {};
        for (const file of files) {
            const decisionId = file.decision?.decisionId ?? null;
            const outcome: DecisionOutcome | undefined = decisionId !== null && isRecorded(file)
                ? { name: file.name, decisionId, ...recorded[decisionId] }
                : byName.get(file.name);
            if (!outcome) continue;
            outcomes.push(outcome);
            if (decisionId === null || outcome.status === 'deferred') continue;
            decided[decisionId] = outcome.status === 'applied' ? { status: 'applied', detail: outcome.detail } : { status: 'rejected', reason: outcome.reason };
        }
        return { outcomes, decided };
    };
    return { fresh, settle };
}

/** `registry` carrying `decided`, or without the field when it is empty. */
function withDecided(registry: Registry, decided: Record<string, RecordedDecision>): Registry {
    const { decided: _previous, ...rest } = registry;
    return Object.keys(decided).length > 0 ? { ...rest, decided } : rest;
}

function dedupeByFactId(facts: readonly IdentityFact[]): IdentityFact[] {
    const seen = new Set<string>();
    return facts.filter((fact) => (seen.has(fact.factId) ? false : (seen.add(fact.factId), true)));
}

/**
 * One reconcile pass. Runs only against a `ready` data root. Under the
 * registry lock it reconciles, writes the registry with the new facts in
 * `pendingFacts` and the stat cache, then delivers every pending fact,
 * leftovers first and deduped by factId, and, with `clearDelivered`, clears
 * what it delivered. A crash before delivery leaves the facts pending, so the
 * next pass delivers them.
 */
export async function runReconcilePass(options: PassOptions = {}): Promise<PassOutcome> {
    const status = dataRootStatus({ versioned: true });
    if (status.state !== 'ready' || status.root === null) {
        return { status: 'skipped', reason: 'data-root', state: status.state, detail: status.detail };
    }
    const root = status.root;
    const { sinks = [], clearDelivered = false, faults, logger = console } = options;
    const idGen = options.idGen ?? randomUUID;

    try {
        // The lease runs on real time even when a test injects the pass clock.
        return await withLock('registry', { root, waitMs: options.lock?.waitMs, leaseMs: options.lock?.leaseMs }, async ({ signal }) => {
            const before = await readRegistry(root);
            const decisions = await readPendingDecisions(root).catch((error: unknown) => {
                logger.warn(`[identity] Could not read identity/decisions/, so this pass applies none: ${(error as Error).message}`);
                return [];
            });
            // A decision an earlier write recorded is filed as it went then, never applied twice.
            const replay = replayDecisions(decisions, before.decided ?? {});
            const observed = await observeLibrary({ root: libraryRoot(), registry: before, statCache: await readStatCache(root), deps: options, decisions: replay.fresh });
            const { outcomes, decided } = replay.settle(observed.decisions);
            signal.throwIfAborted();
            for (const skipped of observed.report.unreadable) logger.warn(`[identity] Skipped ${skipped}: it can't be read.`);
            for (const folder of observed.scan.unreadableDirs) logger.warn(`[identity] Skipped folder ${folder}: it can't be listed.`);

            const facts: IdentityFact[] = observed.facts.map((draft) => ({ ...draft, factId: factIdFor(draft, idGen) }));
            await faults?.beforeRegistryWrite?.();
            const next = withDecided({ ...observed.registry, pendingFacts: [...before.pendingFacts, ...facts] }, decided);
            const written = await writeRegistry(root, next, before.version, faults?.registryWrite);
            await writeStatCache(root, observed.statCache).catch((error: unknown) => {
                logger.warn(`[identity] Could not write the stat cache, so the next pass reads every file again: ${(error as Error).message}`);
            });
            // Only now that the registry holds their effect. After a crash before this, the next pass files them as recorded.
            await faults?.beforeSettle?.();
            await settleDecisions(root, decisions, outcomes, written.updatedAt ?? new Date((options.clock ?? Date.now)()).toISOString()).catch((error: unknown) => {
                logger.warn(`[identity] Could not file the applied and rejected decisions, so the next pass applies them again: ${(error as Error).message}`);
            });
            for (const outcome of outcomes) logger.log(JSON.stringify({ event: 'identity-decision', ...outcome }));
            await faults?.beforeDelivery?.();

            const delivered = dedupeByFactId(written.pendingFacts);
            let deliveredToAll = true;
            for (const sink of sinks) {
                try {
                    await sink(delivered);
                } catch (error) {
                    deliveredToAll = false;
                    logger.error(`[identity] A fact sink failed. The facts stay pending for the next pass: ${(error as Error).message}`);
                }
            }
            await faults?.beforeClear?.();

            let registry = written;
            if (clearDelivered && deliveredToAll && delivered.length > 0) {
                signal.throwIfAborted();
                const ids = new Set(delivered.map((fact) => fact.factId));
                registry = await writeRegistry(root, { ...written, pendingFacts: written.pendingFacts.filter((fact) => !ids.has(fact.factId)) }, written.version);
            }
            return {
                status: 'committed' as const,
                registry,
                facts,
                delivered,
                jobs: observed.jobs,
                report: observed.report,
                retryAfterMs: observed.retryAfterMs,
                decisions: outcomes,
            };
        });
    } catch (error) {
        if (error instanceof LockTimeoutError) return { status: 'skipped', reason: 'locked', holder: error.holder };
        if (error instanceof UnsupportedSchemaError) return { status: 'skipped', reason: 'data-root', state: 'unavailable', detail: error.message };
        throw error;
    }
}
