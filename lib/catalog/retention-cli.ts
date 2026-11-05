import { count, parseFlags, PRINTED_ISSUES, UsageError } from './owner-cli';
import { sizeText } from './asset-folders';
import { PERMANENT_TEXT } from './tombstones';
import { GC_DIGEST_RE, GC_EXIT_CODES, runGc, type GcEntry, type GcKeptReason, type GcOptions, type GcPlan, type GcProtection, type GcResult } from './retention';

/**
 * `photos gc` and `photos gc --apply <planDigest>`, #15's 15-3: argv
 * parsing and report text, kept here so tests can run them in-process.
 * Nothing but the CLI and its tests imports this module.
 */

export interface GcArgs {
    /** The plan digest to apply. Absent for a dry run. */
    apply?: string;
}

/** `photos gc [--apply <planDigest>]`. */
export function gcArgs(args: string[]): GcArgs {
    const { values } = parseFlags({ args, options: { apply: { type: 'string' } } });
    if (values.apply === undefined) return {};
    if (!GC_DIGEST_RE.test(values.apply)) throw new UsageError(`--apply takes the plan digest photos gc printed, gc_ plus 64 hex, not ${values.apply}.`);
    return { apply: values.apply };
}

const KEPT_TEXT: Record<GcKeptReason, string> = {
    'within-grace': 'changed within the last 7 days',
    'build-lock-held': 'a build holds its lock',
    'not-a-folder': 'not a folder a build made',
    'not-a-regular-file': 'not a regular file',
    'has-revision': 'a revision of the same ID exists',
    'named-by-activation': 'an activation names it',
    'named-by-last-publish': 'the last publish names it',
    'tombstone-within-grace': `taken down less than 7 days ago; photos purge --revoke takes it back until photos gc --apply deletes it. ${PERMANENT_TEXT.replace(/\.$/, '')}`,
    'unexpected-content': "taken down, but it holds a file a build didn't make, so GC deletes none of it",
    'set-aside-leftover': 'taken down, but a stopped photos gc --apply run left this asset revision set aside, so GC plans nothing over it until the owner settles that',
    'active-revision': 'taken down, but the live revision shows it',
    'working-layer-series': "taken down, but a draft series lists it at this asset revision",
    'open-inbox': 'taken down, but an open Inbox item names it',
    'live-staging': 'taken down, but a staging folder may be building it',
};

/** What each protection is, for the byte totals. */
const PROTECTION_TEXT: Record<GcProtection, string> = {
    'active-revision': 'the live revision',
    revision: 'older revisions',
    candidate: 'candidates',
    'working-layer-series': 'draft series',
    'working-layer-photo': 'photo records',
    'open-inbox': 'open Inbox items',
    'live-staging': 'staging',
    'tombstone-within-grace': 'tombstones still in their 7 days',
};

const PROTECTION_ORDER = Object.keys(PROTECTION_TEXT) as GcProtection[];

function entryLine(entry: GcEntry): string {
    const at = new Date(entry.newestMs).toISOString();
    if (entry.class === 'tombstoned') {
        const ids = (entry.tombstoneIds ?? []).join(', ');
        return `Delete ${entry.path}: tombstoned, ${sizeText(entry.bytes)} (${count(entry.bytes, 'byte')}) its manifests list. ${entry.rule}: ${ids} took it down more than 7 days ago, and nothing that always keeps an asset names it: not the live revision, a draft series, an open Inbox item, or a staging folder.`;
    }
    const why = entry.class === 'abandoned-staging'
        ? `no build holds its lock, and nothing in it changed since ${at}`
        : `no revision, activation, or last publish names it, and it was last written ${at}`;
    return `Delete ${entry.path}: ${entry.class}, ${count(entry.bytes, 'byte')}. ${entry.rule}: ${why}, more than 7 days ago.`;
}

/** The plan's lines: what goes and why, what of those classes stays and why, what nothing references, the byte totals, and the digest. */
export function gcPlanLines(plan: GcPlan): string[] {
    const lines = plan.delete.slice(0, PRINTED_ISSUES).map(entryLine);
    if (plan.delete.length > PRINTED_ISSUES) lines.push(`And ${plan.delete.length - PRINTED_ISSUES} more.`);
    if (plan.kept.length > 0) {
        const why = (kept: GcPlan['kept'][number]) => {
            if (kept.class === 'tombstoned' && kept.reason === 'not-a-folder') return 'taken down, but a symlink or a file, which GC never deletes through';
            return kept.detail ? `${KEPT_TEXT[kept.reason]}: ${kept.detail}` : KEPT_TEXT[kept.reason];
        };
        const shown = plan.kept.slice(0, PRINTED_ISSUES).map((kept) => `${kept.path} (${why(kept)})`);
        const more = plan.kept.length > PRINTED_ISSUES ? `, and ${plan.kept.length - PRINTED_ISSUES} more` : '';
        lines.push(`Kept ${plan.kept.length}: ${shown.join(', ')}${more}.`);
    }
    const assetFolders = plan.delete.filter((entry) => entry.class === 'tombstoned').length;
    lines.push(assetFolders === 0
        ? `Every asset stays: GC deletes no asset, and the data root holds ${count(plan.references, 'asset reference')}.`
        : `GC deletes ${count(assetFolders, 'asset folder')}, each one a standing tombstone took down more than 7 days ago. Every other asset stays, and the data root holds ${count(plan.references, 'asset reference')}.`);
    if (plan.unreferenced.length > 0) {
        const shown = plan.unreferenced.slice(0, PRINTED_ISSUES).map((set) => `${set.path} (${sizeText(set.bytes)})`);
        const more = plan.unreferenced.length > PRINTED_ISSUES ? `, and ${plan.unreferenced.length - PRINTED_ISSUES} more` : '';
        lines.push(`Unreferenced, reported only: ${count(plan.unreferenced.length, 'set')}, ${sizeText(plan.bytes.unreferenced)}. Nothing references them and no tombstone lists them, and GC deletes none of them: ${shown.join(', ')}${more}.`);
    }
    const kept = PROTECTION_ORDER.filter((key) => (plan.bytes.protected[key] ?? 0) > 0).map((key) => `${PROTECTION_TEXT[key]} ${sizeText(plan.bytes.protected[key] ?? 0)}`);
    lines.push(`Bytes: deletes ${sizeText(plan.bytes.delete)}, unreferenced ${sizeText(plan.bytes.unreferenced)}${kept.length > 0 ? `. Kept for ${kept.join(', ')}` : ''}.`);
    if (plan.assetsNote) lines.push(plan.assetsNote);
    if (plan.leftovers.length > 0) {
        lines.push(`Left by a photos gc --apply run that stopped, reported only, since GC never deletes a folder it set aside in another run: ${plan.leftovers.map((folder) => folder.text).join('; ')}.`);
    }
    lines.push(`Plan digest: ${plan.digest}`);
    return lines;
}

export interface GcIo {
    out(line: string): void;
    err(line: string): void;
}

/**
 * `photos gc`: a dry run prints the plan and its digest, and `--apply`
 * deletes exactly that plan, or stops if it changed. Before its first
 * delete, apply prints one plain line saying what it deletes. Returns the
 * exit code.
 */
export async function runGcCommand(dataRoot: string, args: GcArgs, io: GcIo, options: Partial<Omit<GcOptions, 'dataRoot' | 'apply'>> = {}): Promise<number> {
    const result: GcResult = await runGc({ ...options, dataRoot, apply: args.apply, announce: (line) => io.out(line) });
    const exitCode = GC_EXIT_CODES[result.outcome];
    const print = exitCode === 0 ? io.out : io.err;
    print(`[photos] ${result.outcome}: ${result.message}`);
    for (const path of result.deleted) print(`Deleted ${path}`);
    for (const path of result.partial) print(`Partly deleted ${path}`);
    if (result.plan && result.outcome !== 'APPLIED' && result.deleted.length === 0) {
        for (const line of gcPlanLines(result.plan)) print(line);
        if (result.outcome === 'PLANNED' && result.plan.delete.length > 0) print(`Run photos gc --apply ${result.plan.digest} to delete exactly these.`);
    }
    return exitCode;
}
