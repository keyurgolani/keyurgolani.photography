import { randomUUID } from 'node:crypto';
import type { AtomicWriteFaults } from '../storage/atomicWrite';
import { dataRootStatus, libraryRoot, type DataRootState } from '../storage/config';
import { UnsupportedSchemaError } from '../storage/document';
import { LockTimeoutError, withLock, type LockRecord } from '../storage/lock';
import { sha256, type Hasher } from './ids';
import { inspectEntry, type Inspection } from './inspect';
import { currentProfileId } from './profile';
import { isStillChanging, reconcile, type FactDraft, type ReconcileReport } from './reconcile';
import { emptyStatCache, readRegistry, readStatCache, writeRegistry, writeStatCache, type StatCache, type StatCacheEntry } from './registry';
import { scanLibrary, type LibraryScan } from './scan';
import type { DerivativeJob, IdentityFact, Registry } from './types';

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
}

/**
 * Scan the library, read the files whose size, mtime, or inode changed since
 * the stat cache saw them, and reconcile. Writes nothing.
 */
export async function observeLibrary(
    { root, registry, statCache = emptyStatCache(), deps = {} }: { root: string; registry: Registry; statCache?: StatCache; deps?: PassDeps },
): Promise<ObservedLibrary> {
    const { hasher = sha256, idGen = randomUUID, clock = Date.now } = deps;
    const profileId = deps.profileId ?? currentProfileId();
    const scan = await scanLibrary(root, { clock });

    const inspections = new Map<string, Inspection>();
    const entries: Record<string, StatCacheEntry> = {};
    for (const entry of scan.entries) {
        const cached = statCache.entries[entry.path];
        const unchanged = cached !== undefined && cached.size === entry.size && cached.mtimeMs === entry.mtimeMs &&
            cached.ctimeMs === entry.ctimeMs && cached.ino === entry.ino && (cached.inspection.kind === 'image') === (entry.kind === 'source');
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

    const result = reconcile(scan, registry, (entry) => inspections.get(entry.path), { idGen, profileId });

    // An unsupported file or a digest collision changes no registry state, so report it once per version of the file.
    const facts = result.facts.filter((fact) => {
        if (fact.type !== 'processing-failed' || fact.reason === 'undecodable') return true;
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
    };
}

/** Test hooks for crashes at each step after the registry write. */
export interface PassFaults {
    /** After reconciling, before the registry write. A test can write the registry here as a foreign writer. */
    beforeRegistryWrite?(): void | Promise<void>;
    registryWrite?: AtomicWriteFaults;
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
    }
    | { status: 'skipped'; reason: 'data-root'; state: DataRootState; detail?: string }
    | { status: 'skipped'; reason: 'locked'; holder: LockRecord | null };

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
    const status = dataRootStatus({ write: true });
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
            const observed = await observeLibrary({ root: libraryRoot(), registry: before, statCache: await readStatCache(root), deps: options });
            signal.throwIfAborted();
            for (const skipped of observed.report.unreadable) logger.warn(`[identity] Skipped ${skipped}: it can't be read.`);
            for (const folder of observed.scan.unreadableDirs) logger.warn(`[identity] Skipped folder ${folder}: it can't be listed.`);

            const facts: IdentityFact[] = observed.facts.map((draft) => ({ ...draft, factId: idGen() }));
            await faults?.beforeRegistryWrite?.();
            const written = await writeRegistry(root, { ...observed.registry, pendingFacts: [...before.pendingFacts, ...facts] }, before.version, faults?.registryWrite);
            await writeStatCache(root, observed.statCache).catch((error: unknown) => {
                logger.warn(`[identity] Could not write the stat cache, so the next pass reads every file again: ${(error as Error).message}`);
            });
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
            };
        });
    } catch (error) {
        if (error instanceof LockTimeoutError) return { status: 'skipped', reason: 'locked', holder: error.holder };
        if (error instanceof UnsupportedSchemaError) return { status: 'skipped', reason: 'data-root', state: 'unavailable', detail: error.message };
        throw error;
    }
}
