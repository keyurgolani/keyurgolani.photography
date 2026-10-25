import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../storage/atomicWrite';
import { isRecord } from '../storage/document';
import { hasErrorCode, PRIVATE_DIR_MODE, timestampOf } from '../storage/fsx';
import { ASSET_REVISION_RE, mintPhotoId, PHOTO_ID_RE } from './ids';
import { identityPaths } from './registry';

/**
 * Identity decisions: the owner's answers to what reconcile can't settle
 * alone. `photos:identity` (and later #14's inbox) writes one file per
 * decision to `identity/decisions/`, and the next pass applies them in file
 * order, then moves each to `applied/`, or to `rejected/` with the reason.
 * The registry write that applies them also records what became of each
 * until its file moves, so after a crash between that write and the move the
 * next pass files them as recorded instead of applying them again. Applying
 * one again could come out otherwise, as when a later decision in the same
 * batch changed what it found.
 */

export const DECISION_SCHEMA_VERSION = 1;
export const DECISION_TYPES = ['bind', 'new', 'archive', 'retry', 'reprofile'] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];

interface DecisionBase {
    schemaVersion: typeof DECISION_SCHEMA_VERSION;
    decisionId: string;
    actor: string;
    reason: string;
    createdAt: string;
}

/**
 * `path` is library-relative POSIX. `new` carries the photoId minted for its
 * path when the decision was written, so applying it again mints nothing.
 * `bind` with `merge` names the photo holding the path that it may merge
 * into `photoId`. `retry` without `assetRevision` covers every revision of
 * the photo, and `reprofile` without `photoId` covers every photo.
 */
export type IdentityDecision =
    | (DecisionBase & { type: 'bind'; path: string; photoId: string; merge?: string })
    | (DecisionBase & { type: 'new'; path: string; photoId: string })
    | (DecisionBase & { type: 'archive'; photoId: string })
    | (DecisionBase & { type: 'retry'; photoId: string; assetRevision?: string })
    | (DecisionBase & { type: 'reprofile'; photoId?: string });

/** One file found in `identity/decisions/`. */
export interface DecisionFile {
    /** The file name inside `identity/decisions/`. */
    name: string;
    /** Null when the file isn't a valid decision. */
    decision: IdentityDecision | null;
    /** Why it isn't valid. */
    invalid?: string;
    /** The file's text, kept in the rejected record when it doesn't parse. Null when unreadable, and then the file waits for a later pass. */
    raw: string | null;
}

export type DecisionOutcome =
    | { name: string; decisionId: string | null; status: 'applied'; detail: string }
    | { name: string; decisionId: string | null; status: 'rejected'; reason: string }
    /** Left in place for a later pass, such as when the file at its path is still being written. */
    | { name: string; decisionId: string | null; status: 'deferred'; reason: string };

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FIELDS = new Set(['schemaVersion', 'decisionId', 'type', 'path', 'photoId', 'merge', 'assetRevision', 'actor', 'reason', 'createdAt']);
/** Which of the optional fields each type takes, and which it requires. */
const SHAPES: Record<DecisionType, { path: 'required' | 'none'; photoId: 'required' | 'optional'; merge: 'optional' | 'none'; assetRevision: 'optional' | 'none' }> = {
    bind: { path: 'required', photoId: 'required', merge: 'optional', assetRevision: 'none' },
    new: { path: 'required', photoId: 'required', merge: 'none', assetRevision: 'none' },
    archive: { path: 'none', photoId: 'required', merge: 'none', assetRevision: 'none' },
    retry: { path: 'none', photoId: 'required', merge: 'none', assetRevision: 'optional' },
    reprofile: { path: 'none', photoId: 'optional', merge: 'none', assetRevision: 'none' },
};

/** A library-relative POSIX path with no empty, `.`, or `..` segment. */
export function isLibraryPath(value: string): boolean {
    // An empty path, an absolute one, and a doubled slash all split into an empty segment.
    return !value.includes('\0') && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Check a parsed decision file. Returns the decision, or why it isn't one. */
export function parseDecision(value: unknown): { decision: IdentityDecision } | { invalid: string } {
    if (!isRecord(value)) return { invalid: 'it is not a JSON object' };
    for (const key of Object.keys(value)) if (!FIELDS.has(key)) return { invalid: `unknown field ${key}` };
    if (value.schemaVersion !== DECISION_SCHEMA_VERSION) {
        const newer = typeof value.schemaVersion === 'number' && value.schemaVersion > DECISION_SCHEMA_VERSION;
        return { invalid: newer ? `schemaVersion ${value.schemaVersion} comes from a newer build` : 'schemaVersion must be 1' };
    }
    const { decisionId, type, path: target, photoId, merge, assetRevision, actor, reason, createdAt } = value;
    if (typeof decisionId !== 'string' || !UUID_V4_RE.test(decisionId)) return { invalid: 'decisionId must be a lowercase UUID v4' };
    if (typeof type !== 'string' || !(DECISION_TYPES as readonly string[]).includes(type)) return { invalid: `type must be one of ${DECISION_TYPES.join(', ')}` };
    if (typeof actor !== 'string' || actor.length === 0) return { invalid: 'actor must be a non-empty string' };
    if (typeof reason !== 'string') return { invalid: 'reason must be a string' };
    if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
        return { invalid: 'createdAt must be an ISO timestamp' };
    }
    const shape = SHAPES[type as DecisionType];
    if (shape.path === 'required' && (typeof target !== 'string' || !isLibraryPath(target))) return { invalid: `${type} needs a library-relative path` };
    if (shape.path === 'none' && target !== undefined) return { invalid: `${type} takes no path` };
    if (photoId !== undefined && (typeof photoId !== 'string' || !PHOTO_ID_RE.test(photoId))) return { invalid: 'photoId must be ph_ plus a UUID v4' };
    if (shape.photoId === 'required' && photoId === undefined) return { invalid: `${type} needs a photoId` };
    if (merge !== undefined && shape.merge === 'none') return { invalid: `${type} takes no merge` };
    if (merge !== undefined && (typeof merge !== 'string' || !PHOTO_ID_RE.test(merge))) return { invalid: 'merge must be ph_ plus a UUID v4' };
    if (merge !== undefined && merge === photoId) return { invalid: 'merge must name a photo other than photoId' };
    if (assetRevision !== undefined && (typeof assetRevision !== 'string' || !ASSET_REVISION_RE.test(assetRevision))) {
        return { invalid: 'assetRevision must be sha256- plus 64 hex' };
    }
    if (shape.assetRevision === 'none' && assetRevision !== undefined) return { invalid: `${type} takes no assetRevision` };
    return { decision: value as unknown as IdentityDecision };
}

/** `<createdAt>-<decisionId>.json`, so file order is the order decisions were made. */
export function decisionFileName(decision: Pick<IdentityDecision, 'createdAt' | 'decisionId'>): string {
    return `${timestampOf(decision.createdAt)}-${decision.decisionId}.json`;
}

export interface DecisionInput {
    type: DecisionType;
    path?: string;
    photoId?: string;
    merge?: string;
    assetRevision?: string;
    actor: string;
    reason?: string;
}

/**
 * A new decision, validated. A `new` decision gets its photoId minted here.
 * Throws a TypeError naming the problem when the input doesn't make one.
 */
export function createDecision(input: DecisionInput, { idGen = randomUUID, clock = Date.now }: { idGen?: () => string; clock?: () => number } = {}): IdentityDecision {
    if (input.type === 'new' && input.photoId !== undefined) throw new TypeError('new mints its own photoId');
    const candidate = {
        schemaVersion: DECISION_SCHEMA_VERSION,
        decisionId: idGen().toLowerCase(),
        type: input.type,
        ...(input.path === undefined ? {} : { path: input.path }),
        ...(input.type === 'new' ? { photoId: mintPhotoId(idGen) } : input.photoId === undefined ? {} : { photoId: input.photoId }),
        ...(input.merge === undefined ? {} : { merge: input.merge }),
        ...(input.assetRevision === undefined ? {} : { assetRevision: input.assetRevision }),
        actor: input.actor,
        reason: input.reason ?? '',
        createdAt: new Date(clock()).toISOString(),
    };
    const parsed = parseDecision(candidate);
    if ('invalid' in parsed) throw new TypeError(`Not a valid ${input.type} decision: ${parsed.invalid}`);
    return parsed.decision;
}

/** Write a decision for the next pass. Returns its path. */
export async function writeDecision(root: string, decision: IdentityDecision): Promise<string> {
    const dir = identityPaths(root).decisions;
    await fs.promises.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    const file = path.join(dir, decisionFileName(decision));
    await atomicWriteJson(file, decision);
    return file;
}

/** The decisions waiting in `identity/decisions/`, in file order. Dot-files, temp files, and folders are skipped. */
export async function readPendingDecisions(root: string): Promise<DecisionFile[]> {
    const dir = identityPaths(root).decisions;
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return [];
        throw error;
    }
    const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.')).map((entry) => entry.name).sort();
    const files: DecisionFile[] = [];
    for (const name of names) {
        let raw: string;
        try {
            raw = await fs.promises.readFile(path.join(dir, name), 'utf8');
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) continue; // Moved away since the listing.
            files.push({ name, decision: null, invalid: `it can't be read: ${(error as Error).message}`, raw: null });
            continue;
        }
        let value: unknown;
        try {
            value = JSON.parse(raw);
        } catch {
            files.push({ name, decision: null, invalid: 'it is not valid JSON', raw });
            continue;
        }
        const parsed = parseDecision(value);
        files.push('decision' in parsed ? { name, decision: parsed.decision, raw } : { name, decision: null, invalid: parsed.invalid, raw });
    }
    return files;
}

/**
 * Move applied decisions to `applied/` as they are, and replace rejected
 * ones with a record in `rejected/` holding the decision (or its text) and
 * the reason. Deferred decisions stay. Call it only after the registry write
 * that applied them.
 */
export async function settleDecisions(root: string, files: readonly DecisionFile[], outcomes: readonly DecisionOutcome[], at: string): Promise<void> {
    const dir = identityPaths(root).decisions;
    const byName = new Map(files.map((file) => [file.name, file]));
    for (const outcome of outcomes) {
        if (outcome.status === 'deferred') continue;
        const source = path.join(dir, outcome.name);
        const targetDir = path.join(dir, outcome.status);
        await fs.promises.mkdir(targetDir, { recursive: true, mode: PRIVATE_DIR_MODE });
        if (outcome.status === 'applied') {
            await fs.promises.rename(source, path.join(targetDir, outcome.name)).catch((error: unknown) => {
                if (!hasErrorCode(error, 'ENOENT')) throw error;
            });
            continue;
        }
        const file = byName.get(outcome.name);
        await atomicWriteJson(path.join(targetDir, outcome.name), {
            rejectedAt: at,
            reason: outcome.reason,
            ...(file?.decision ? { decision: file.decision } : { raw: file?.raw ?? null }),
        });
        await fs.promises.rm(source, { force: true });
    }
}
