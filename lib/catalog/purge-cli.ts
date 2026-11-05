import type { PurgeOptions, PurgePlan, RevokeOptions } from './purge';

/**
 * `photos purge` and `photos purge --revoke`, #181's A10. A stub for the
 * red tests: the interface only. Everything throws until it lands.
 */

export type PurgeArgs =
    | { kind: 'purge'; photoId: string; assetRevision?: string; reason: string; actor: string; yes: boolean }
    | { kind: 'revoke'; tombstoneId: string; reason: string; actor: string; yes: boolean };

export function purgeArgs(args: string[], env: Record<string, string | undefined> = process.env): PurgeArgs {
    throw new Error(`Not implemented yet: #181 A10 (${args.length} arguments, ${Object.keys(env).length} variables).`);
}

export function purgePlanLines(plan: PurgePlan): string[] {
    throw new Error(`Not implemented yet: #181 A10 (${plan.photoId}).`);
}

export interface PurgeIo {
    out(line: string): void;
    err(line: string): void;
}

export async function runPurgeCommand(
    dataRoot: string,
    args: PurgeArgs,
    io: PurgeIo,
    options: Partial<Omit<PurgeOptions & RevokeOptions, 'dataRoot' | 'photoId' | 'assetRevision' | 'tombstoneId' | 'reason' | 'actor' | 'yes' | 'onPlan'>> = {},
): Promise<number> {
    throw new Error(`Not implemented yet: #181 A10 (${dataRoot}, ${args.kind}, ${typeof io}, ${Object.keys(options).length}).`);
}
