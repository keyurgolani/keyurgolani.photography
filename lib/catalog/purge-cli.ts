import { ASSET_REVISION_RE, PHOTO_ID_RE } from '../identity/ids';
import { count, parseFlags, PRINTED_ISSUES, UsageError } from './owner-cli';
import { PURGE_EXIT_CODES, runPurge, runRevoke, type PurgeOptions, type PurgePlan, type PurgeResult, type RevokeOptions } from './purge';
import { sizeText } from './retention';
import { TOMBSTONE_ID_RE } from './tombstones';

/**
 * `photos purge` and `photos purge --revoke`, #181's A10: argv parsing and
 * report text, kept here so tests can run them in-process. Nothing but the
 * CLI and its tests imports this module.
 */

export type PurgeArgs =
    | { kind: 'purge'; photoId: string; assetRevision?: string; reason: string; actor: string; yes: boolean }
    | { kind: 'revoke'; tombstoneId: string; reason: string; actor: string; yes: boolean };

/**
 * `photos purge <photoId> [--asset-revision <assetRevision>] --reason <text> [--actor <name>] [--yes]`
 * and `photos purge --revoke <tombstoneId> --reason <text> [--actor <name>] [--yes]`.
 */
export function purgeArgs(args: string[], env: Record<string, string | undefined> = process.env): PurgeArgs {
    const { values, positionals } = parseFlags({
        args,
        options: { 'asset-revision': { type: 'string' }, revoke: { type: 'string' }, reason: { type: 'string' }, actor: { type: 'string' }, yes: { type: 'boolean' } },
        allowPositionals: true,
    });
    if (positionals.length > 1) throw new UsageError('photos purge takes one photo ID.');
    const [photoId] = positionals;
    if (values.revoke !== undefined && photoId !== undefined) throw new UsageError('photos purge takes a photo ID or --revoke <tombstoneId>, not both.');
    if (values.revoke !== undefined && values['asset-revision'] !== undefined) throw new UsageError('--asset-revision goes with a photo ID, not with --revoke.');
    if (values.revoke === undefined && photoId === undefined) throw new UsageError('photos purge needs a photo ID, or --revoke <tombstoneId>.');
    if (values.reason === undefined || !/\S/.test(values.reason)) throw new UsageError('photos purge needs --reason <text>, which the tombstone records.');
    const actor = values.actor ?? env.PHOTOS_ACTOR ?? '';
    if (!/\S/.test(actor)) throw new UsageError('photos purge needs --actor <name> or PHOTOS_ACTOR.');
    const common = { reason: values.reason.trim(), actor: actor.trim(), yes: values.yes === true };
    if (values.revoke !== undefined) {
        if (!TOMBSTONE_ID_RE.test(values.revoke)) throw new UsageError(`--revoke takes a tombstone ID, tomb_ and a UUID, not ${values.revoke}.`);
        return { kind: 'revoke', tombstoneId: values.revoke, ...common };
    }
    if (!PHOTO_ID_RE.test(photoId ?? '')) throw new UsageError(`${photoId} is not a photo ID.`);
    const assetRevision = values['asset-revision'];
    if (assetRevision !== undefined && !ASSET_REVISION_RE.test(assetRevision)) throw new UsageError(`--asset-revision takes an asset revision, sha256- and 64 hex, not ${assetRevision}.`);
    return { kind: 'purge', photoId: photoId as string, ...(assetRevision === undefined ? {} : { assetRevision }), ...common };
}

/** What a purge takes down, line by line: the plain line, each asset revision and set, and each revision that loses rollback eligibility. */
export function purgePlanLines(plan: PurgePlan): string[] {
    const lines = [plan.summary];
    for (const revision of plan.assetRevisions) {
        const already = revision.takenDownBy.length > 0 ? ` Already taken down by ${revision.takenDownBy.join(', ')}.` : '';
        lines.push(`  ${revision.assetRevision}: ${count(revision.sets.length, 'set')}, ${sizeText(revision.bytes)}.${already}`);
        for (const set of revision.sets.slice(0, PRINTED_ISSUES)) lines.push(`    ${set.path}: ${sizeText(set.bytes)}`);
        if (revision.sets.length > PRINTED_ISSUES) lines.push(`    And ${revision.sets.length - PRINTED_ISSUES} more.`);
    }
    if (plan.losing.length === 0) {
        lines.push('No revision that was live before shows it, so no rollback loses a target.');
    } else {
        lines.push(`No rollback can return to these while it stands, since they show it: ${plan.losing.map((revision) => `revision ${revision.revisionNumber} (${revision.revisionId})`).join(', ')}.`);
    }
    return lines;
}

export interface PurgeIo {
    out(line: string): void;
    err(line: string): void;
}

/**
 * `photos purge`: prints what it takes down, or would bring back, before it
 * writes anything, then the outcome. Returns the exit code.
 */
export async function runPurgeCommand(
    dataRoot: string,
    args: PurgeArgs,
    io: PurgeIo,
    options: Partial<Omit<PurgeOptions & RevokeOptions, 'dataRoot' | 'photoId' | 'assetRevision' | 'tombstoneId' | 'reason' | 'actor' | 'yes' | 'onPlan'>> = {},
): Promise<number> {
    const common = { ...options, dataRoot, reason: args.reason, actor: args.actor, yes: args.yes };
    const result: PurgeResult = args.kind === 'revoke'
        ? await runRevoke({ ...common, tombstoneId: args.tombstoneId, onPlan: (plan) => io.out(plan.summary) })
        : await runPurge({ ...common, photoId: args.photoId, assetRevision: args.assetRevision, onPlan: (plan) => purgePlanLines(plan).forEach((line) => io.out(line)) });
    const exitCode = PURGE_EXIT_CODES[result.outcome];
    (exitCode === 0 ? io.out : io.err)(`[photos] ${result.outcome}: ${result.message}`);
    return exitCode;
}
