import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile, atomicWriteJson } from '../storage/atomicWrite';
import { dataRootStatus, libraryRoot, servedFolderContaining, type DataRootState } from '../storage/config';
import { PRIVATE_DIR_MODE } from '../storage/fsx';
import { observeLibrary, withReportedFailures, type ObservedLibrary, type PassDeps } from './pass';
import { currentProfileId } from './profile';
import { STABILITY_MS, type FactDraft } from './reconcile';
import { emptyStatCache, identityPaths, readRegistry, readStatCache, type StatCache } from './registry';
import { keyOf } from './scan';
import { emptyRegistry, type Hold, type IdentityFactType, type Registry, type SourceHealth } from './types';

/** The migration report's sections. Every one is always present, in this order, so a missing category shows. */
export const REPORT_SECTIONS = [
    'Fact counts',
    'Proposed photo IDs',
    'Duplicate-byte groups',
    'Basename collisions',
    'Unreadable files',
    'Unsupported files',
    'Orientation-tagged files',
    'Ambiguous items',
    'Undecodable files',
    'Digest collisions',
    'Files still changing',
] as const;

const FACT_TYPES: IdentityFactType[] = ['new', 'renamed', 'reappeared', 'replaced', 'metadata-changed', 'ambiguous', 'missing', 'processing-failed'];

export interface PlannedPhoto {
    photoId: string;
    path: string;
    assetRevision: string;
    status: 'new' | 'existing';
    sourceHealth: SourceHealth;
    duplicateOf?: string;
}

export interface PlannedSource {
    path: string;
    size: number;
    /** Null for a file that couldn't be read or was still changing. */
    assetRevision: string | null;
}

/** `plan-<ts>.json`: the IDs a dry run proposes and the sources it saw, so an apply can refuse on drift. */
export interface MigrationPlan {
    schemaVersion: 1;
    planId: string;
    createdAt: string;
    libraryRoot: string;
    dataRoot: string | null;
    dataRootState: DataRootState;
    /** The registry version the plan was made against, 0 when there was none. */
    registryVersion: number;
    profileId: string;
    sources: PlannedSource[];
    /** Folders the scan couldn't list. None of their files are in `sources`, which doesn't mean they are gone. */
    unreadableFolders: string[];
    photos: PlannedPhoto[];
    holds: Hold[];
    facts: FactDraft[];
}

export interface DryRunOptions extends PassDeps {
    /** Where to write the plan and report. Required when the data root is unset, unavailable, or unwritable. */
    outDir?: string;
    /** How long to wait for files still being written before reporting them as changing. */
    settleMs?: number;
    sleep?: (ms: number) => Promise<void>;
}

export interface DryRunResult {
    planPath: string;
    reportPath: string;
    plan: MigrationPlan;
    report: string;
}

/** The dry run can't proceed. `exitCode` is 2 for a usage problem and 1 for anything else. */
export class DryRunRefusedError extends Error {
    readonly exitCode: number;

    constructor(message: string, exitCode: number) {
        super(message);
        this.name = 'DryRunRefusedError';
        this.exitCode = exitCode;
    }
}

/** A filesystem-safe form of an ISO timestamp, such as 2026-10-20T06-34-12-123Z. */
export function timestampOf(iso: string): string {
    return iso.replace(/[:.]/g, '-');
}

function code(text: string): string {
    return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
}

/** A table cell's content, with each pipe escaped so a path that holds one stays in its column. */
function cell(text: string): string {
    return text.replace(/\|/g, '\\|');
}

function bullets(items: string[]): string[] {
    return items.length === 0 ? ['None.'] : items.map((item) => `- ${item}`);
}

function groupBy<T>(items: T[], keyOf: (item: T) => string | null): Map<string, T[]> {
    const groups = new Map<string, T[]>();
    for (const item of items) {
        const key = keyOf(item);
        if (key === null) continue;
        groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return groups;
}

export function buildPlan(
    observed: ObservedLibrary,
    context: { before: Registry; libraryRoot: string; dataRoot: string | null; state: DataRootState; profileId: string; planId: string; createdAt: string },
): MigrationPlan {
    return {
        schemaVersion: 1,
        planId: context.planId,
        createdAt: context.createdAt,
        libraryRoot: context.libraryRoot,
        dataRoot: context.dataRoot,
        dataRootState: context.state,
        registryVersion: context.before.version,
        profileId: context.profileId,
        sources: observed.scan.entries.map((entry) => {
            const inspection = observed.inspections.get(entry.path);
            const readable = inspection?.kind === 'image' || inspection?.kind === 'unsupported';
            return { path: entry.path, size: entry.size, assetRevision: readable ? inspection.assetRevision : null };
        }),
        unreadableFolders: observed.scan.unreadableDirs,
        photos: Object.values(observed.registry.photos)
            .map((photo): PlannedPhoto => ({
                photoId: photo.photoId,
                path: photo.source.path,
                assetRevision: photo.source.observedRevision,
                status: context.before.photos[photo.photoId] ? 'existing' : 'new',
                sourceHealth: photo.sourceHealth,
                ...(photo.duplicateOf ? { duplicateOf: photo.duplicateOf } : {}),
            }))
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
        holds: observed.registry.holds,
        facts: observed.facts,
    };
}

/** Render the dry run as Markdown for the owner. It names paths, so it stays in the data root or `--out`. */
export function renderReport(plan: MigrationPlan, observed: ObservedLibrary): string {
    const { report } = observed;
    const lines: string[] = [
        '# Photo identity migration dry run',
        '',
        `- Created: ${plan.createdAt}`,
        `- Plan: ${code(`plan-${timestampOf(plan.createdAt)}.json`)}, planId ${code(plan.planId)}`,
        `- Library: ${code(plan.libraryRoot)}`,
        `- Data root: ${plan.dataRoot ? code(plan.dataRoot) : 'not set'} (${plan.dataRootState})`,
        `- Registry version: ${plan.registryVersion === 0 ? 'none yet' : plan.registryVersion}`,
        `- Derivative profile: ${code(plan.profileId)}`,
        `- Files scanned: ${plan.sources.length}`,
        '',
        'This dry run wrote only this report and its plan. Applying a plan builds no derivatives; the watcher does.',
    ];
    const section = (title: (typeof REPORT_SECTIONS)[number], body: string[]) => lines.push('', `## ${title}`, '', ...body);

    const counts = new Map<IdentityFactType, number>(FACT_TYPES.map((type) => [type, 0]));
    for (const fact of plan.facts) counts.set(fact.type, (counts.get(fact.type) ?? 0) + 1);
    section('Fact counts', ['| Fact | Count |', '| --- | --- |', ...FACT_TYPES.map((type) => `| ${type} | ${counts.get(type)} |`)]);

    const proposed = plan.photos.filter((photo) => photo.status === 'new');
    section('Proposed photo IDs', [
        `${proposed.length} new, ${plan.photos.length - proposed.length} already in the registry.`,
        ...(proposed.length === 0 ? [] : [
            '',
            '| Path | Proposed photoId | Duplicate of |',
            '| --- | --- | --- |',
            ...proposed.map((photo) => `| ${cell(code(photo.path))} | ${cell(code(photo.photoId))} | ${photo.duplicateOf ? cell(code(photo.duplicateOf)) : ''} |`),
        ]),
    ]);

    const images = plan.sources.filter((source) => observed.inspections.get(source.path)?.kind === 'image');
    const duplicates = [...groupBy(images, (source) => source.assetRevision).values()].filter((group) => group.length > 1);
    section('Duplicate-byte groups', duplicates.length === 0 ? ['None.'] : [
        'Each file stays its own photo. Later ones point at the first with duplicateOf.',
        '',
        ...duplicates.map((group) => `- ${group.map((source) => code(source.path)).join(', ')}`),
    ]);

    const topLevel = images.filter((source) => !source.path.includes('/'));
    // Folded as the scan folds paths, since base names that differ only by case or Unicode form share one set on a case-insensitive disk.
    const sharedBase = [...groupBy(topLevel, (source) => keyOf(path.posix.basename(source.path, path.posix.extname(source.path)))).values()]
        .filter((group) => group.length > 1);
    section('Basename collisions', sharedBase.length === 0 ? ['None.'] : [
        "These top-level files share one set of legacy derivative URLs, or would on a case-insensitive disk, so those URLs can't be mapped to a single photo.",
        '',
        ...sharedBase.map((group) => `- ${group.map((source) => code(source.path)).join(', ')}`),
    ]);

    section('Unreadable files', bullets([
        ...report.unreadable.map(code),
        ...plan.unreadableFolders.map((folder) => `${code(`${folder}/`)}: this folder can't be listed, so none of its files are in this plan.`),
    ]));
    section('Unsupported files', bullets(report.unsupported.map(code)));

    // The photos the legacy rebuild turns upright: top-level ones, since it builds sets only for those.
    const oriented = topLevel.flatMap((source) => {
        const inspection = observed.inspections.get(source.path);
        return inspection?.kind === 'image' && inspection.orientation !== null && inspection.orientation !== 1
            ? [`${code(source.path)}: orientation ${inspection.orientation}`]
            : [];
    });
    // Top-level photos it couldn't read, or that were still changing, so their orientation is unknown
    const notChecked = observed.scan.entries
        .filter((entry) => entry.kind === 'source' && !entry.path.includes('/') && observed.inspections.get(entry.path)?.kind !== 'image')
        .map((entry) => code(entry.path));
    section('Orientation-tagged files', [
        ...(oriented.length === 0 ? [notChecked.length === 0 ? 'None.' : 'None among the photos it read.'] : [
            'The rebuild turns these top-level photos upright, and orientations 5 to 8 swap width and height.',
            '',
            ...oriented.map((line) => `- ${line}`),
        ]),
        ...(notChecked.length === 0 ? [] : ['', "Not checked, since they couldn't be read or were still changing:", '', ...notChecked.map((item) => `- ${item}`)]),
    ]);

    const ambiguous = [
        ...plan.holds.map((held) => `${code(held.path)} is held. Candidates: ${held.candidates.length === 0 ? 'none' : held.candidates.map(code).join(', ')}.`),
        ...report.keyCollisions.map((group) => `${group.map(code).join(' and ')} differ only by case or Unicode form.`),
    ];
    section('Ambiguous items', bullets(ambiguous));
    section('Undecodable files', bullets(report.undecodable.map(code)));
    section('Digest collisions', bullets(report.collisions.map(code)));
    section('Files still changing', bullets(report.unstable.map(code)));
    return `${lines.join('\n')}\n`;
}

/**
 * `photos:migrate --dry-run`: a write-disabled pass that proposes photo IDs.
 * It takes no lock and writes only `plan-<ts>.json` and `report-<ts>.md`, to
 * `identity/migration/` in the data root or to `outDir`, which is required
 * when the data root is unset, unavailable, or unwritable.
 */
export async function migrateDryRun(options: DryRunOptions = {}): Promise<DryRunResult> {
    const { clock = Date.now, settleMs = 30_000, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) } = options;
    const library = libraryRoot();
    const status = dataRootStatus({ write: true });
    if (status.cause === 'newer-schema') {
        throw new DryRunRefusedError(`The data root at ${status.root} comes from a newer build: ${status.detail}. Upgrade before migrating.`, 1);
    }
    const writable = status.state === 'ready' || status.state === 'uninitialized';
    if (!options.outDir && !writable) {
        throw new DryRunRefusedError(`--out <dir> is required because the data root is ${status.state}${status.detail ? ` (${status.detail})` : ''}.`, 2);
    }
    const outDir = options.outDir ? path.resolve(options.outDir) : identityPaths(status.root as string).migration;
    const served = options.outDir ? servedFolderContaining(outDir) : null;
    if (served !== null) {
        throw new DryRunRefusedError(`--out ${outDir} is inside ${served}, and the report names every library path. Choose a folder outside it.`, 2);
    }

    // Read any registry that exists, even beside a missing data-root.json, so its IDs are kept, not re-minted.
    const unreadable = status.root === null || status.cause === 'missing' || status.cause === 'not-a-directory' || status.cause === 'not-readable';
    const registry: Registry = unreadable ? emptyRegistry() : await readRegistry(status.root as string);
    const statCache: StatCache = unreadable ? emptyStatCache() : await readStatCache(status.root as string);

    const profileId = options.profileId ?? currentProfileId();
    const deps: PassDeps = { ...options, profileId };
    let observed = await observeLibrary({ root: library, registry, statCache, deps });
    for (let waited = 0; observed.retryAfterMs !== null && waited + STABILITY_MS <= settleMs; waited += STABILITY_MS) {
        await sleep(STABILITY_MS);
        // Reuse what the last attempt read, so only files that changed since are read again. A dry run
        // reports nothing, so the failures that attempt found must still count as unreported.
        observed = await observeLibrary({ root: library, registry, statCache: withReportedFailures(observed.statCache, statCache), deps });
    }

    const createdAt = new Date(clock()).toISOString();
    const plan = buildPlan(observed, {
        before: registry,
        libraryRoot: library,
        dataRoot: status.root,
        state: status.state,
        profileId,
        planId: randomUUID(),
        createdAt,
    });
    const report = renderReport(plan, observed);

    await fs.promises.mkdir(outDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    const stamp = timestampOf(createdAt);
    const planPath = path.join(outDir, `plan-${stamp}.json`);
    const reportPath = path.join(outDir, `report-${stamp}.md`);
    await atomicWriteJson(planPath, plan);
    await atomicWriteFile(reportPath, report);
    return { planPath, reportPath, plan, report };
}
