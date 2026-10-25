import { count, parseFlags, PRINTED_ISSUES, UsageError } from './owner-cli';
import { GC_DIGEST_RE, GC_EXIT_CODES, runGc, type GcEntry, type GcKeptReason, type GcOptions, type GcPlan, type GcResult } from './retention';

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
    'named-by-active-pointer': 'the active pointer names it',
    'named-by-last-publish': 'the last publish names it',
};

function entryLine(entry: GcEntry): string {
    const at = new Date(entry.newestMs).toISOString();
    const why = entry.class === 'abandoned-staging'
        ? `no build holds its lock, and nothing in it changed since ${at}`
        : `no revision, activation, active pointer, or last publish names it, and it was last written ${at}`;
    return `Delete ${entry.path}: ${entry.class}, ${count(entry.bytes, 'byte')}. ${entry.rule}: ${why}, more than 7 days ago.`;
}

/** The plan's lines: what goes and why, what of those classes stays and why, and the digest. */
export function gcPlanLines(plan: GcPlan): string[] {
    const lines = plan.delete.slice(0, PRINTED_ISSUES).map(entryLine);
    if (plan.delete.length > PRINTED_ISSUES) lines.push(`And ${plan.delete.length - PRINTED_ISSUES} more.`);
    if (plan.kept.length > 0) {
        const shown = plan.kept.slice(0, PRINTED_ISSUES).map((kept) => `${kept.path} (${KEPT_TEXT[kept.reason]})`);
        const more = plan.kept.length > PRINTED_ISSUES ? `, and ${plan.kept.length - PRINTED_ISSUES} more` : '';
        lines.push(`Kept ${plan.kept.length}: ${shown.join(', ')}${more}.`);
    }
    lines.push(`Every asset stays: GC deletes no asset, and the data root holds ${count(plan.references, 'asset reference')}.`);
    lines.push(`Plan digest: ${plan.digest}`);
    return lines;
}

export interface GcIo {
    out(line: string): void;
    err(line: string): void;
}

/**
 * `photos gc`: a dry run prints the plan and its digest, and `--apply`
 * deletes exactly that plan, or stops if it changed. Returns the exit code.
 */
export async function runGcCommand(dataRoot: string, args: GcArgs, io: GcIo, options: Partial<Omit<GcOptions, 'dataRoot' | 'apply'>> = {}): Promise<number> {
    const result: GcResult = await runGc({ ...options, dataRoot, apply: args.apply });
    const exitCode = GC_EXIT_CODES[result.outcome];
    const print = exitCode === 0 ? io.out : io.err;
    print(`[photos] ${result.outcome}: ${result.message}`);
    for (const path of result.deleted) print(`Deleted ${path}`);
    if (result.plan && result.outcome !== 'APPLIED' && result.deleted.length === 0) {
        for (const line of gcPlanLines(result.plan)) print(line);
        if (result.outcome === 'PLANNED' && result.plan.delete.length > 0) print(`Run photos gc --apply ${result.plan.digest} to delete exactly these.`);
    }
    return exitCode;
}
