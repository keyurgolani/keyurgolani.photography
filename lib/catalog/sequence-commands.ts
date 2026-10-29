import path from 'node:path';
import { applySequenceOp, type Actor, type Consequence, type OrderError, type Placement, type SequenceOp } from './sequence';
import type { AuthoredSeries, FocalPoint } from './types';
import { readAuthoredRecord } from './working-layer';

/**
 * Handlers for #13 slice D's `photos:sequence` and `photos:series` commands.
 * They take parsed arguments and a data root, and return the exit code and
 * the text to print. #13 slice D parses argv and wires the process.
 *
 * Exit codes: 0 on success, 1 for an operation the rules refuse, 2 for a
 * usage error, 3 for version-conflict or authored-locked, and 4 for I/O
 * (#13's STORAGE_ERROR).
 */

export interface LayerHandle {
    dataRoot: string;
    /** How long to wait for the authored lock. Defaults to the operations' 10 s. */
    waitMs?: number;
}

/** `--start`, `--end`, `--after <photoId>`, or `--to <N>`, 1-based: the photo ends up at position N. */
export type PlacementArg = Placement | { to: number };

/** `expectVersion` is `--expect-version`, the current version when omitted. */
export type SequenceCommand =
    | { command: 'show'; seriesId: string }
    | { command: 'set'; seriesId: string; photoIds: string[]; expectVersion?: number }
    | { command: 'insert' | 'move'; seriesId: string; photoId: string; at: PlacementArg; expectVersion?: number }
    | { command: 'remove'; seriesId: string; photoId: string; expectVersion?: number }
    /** `--focal <x>,<y>`, or `--clear-focal` as 'clear'. */
    | { command: 'cover'; seriesId: string; photoId: string; focal?: FocalPoint | 'clear'; expectVersion?: number }
    /** `opening --clear` is a null photoId. */
    | { command: 'opening'; seriesId: string; photoId: string | null; expectVersion?: number }
    | { command: 'chapter-add'; seriesId: string; title: string; startPhotoId: string; expectVersion?: number }
    | { command: 'chapter-move'; seriesId: string; chapterId: string; startPhotoId: string; expectVersion?: number }
    | { command: 'chapter-remove'; seriesId: string; chapterId: string; expectVersion?: number }
    | { command: 'series-order' | 'series-featured'; seriesIds: string[]; expectVersion?: number };

export interface CommandResult {
    exitCode: 0 | 1 | 2 | 3 | 4;
    output: string;
}

const EDITOR: Actor = { kind: 'editor' };

class UsageError extends Error {}

/**
 * Where a photo goes so that it ends up at 1-based `position` in the result,
 * as an anchor, or null when the result has no such position.
 */
export function placementAt(photoIds: readonly string[], photoId: string, position: number): Placement | null {
    const rest = photoIds.filter((id) => id !== photoId);
    if (position < 1 || position > rest.length + 1) return null;
    return position === 1 ? 'start' : { after: rest[position - 2] };
}

const photographs = (count: number) => `${count} photograph${count === 1 ? '' : 's'}`;
const number = (index: number, total: number) => String(index + 1).padStart(Math.max(2, String(total).length), '0');

/** What #13's description rules would say about a member, if anything. */
async function descriptionMark(root: string, photoId: string): Promise<string | null> {
    let photo;
    try {
        photo = await readAuthoredRecord(root, 'photo', photoId);
    } catch {
        return 'photo record can\'t be read';
    }
    if (!photo) return 'no photo record';
    if (photo.alt === null) return photo.carryOver !== undefined ? 'no description yet' : 'no description';
    if (photo.alt.kind === 'described' && !photo.alt.reviewed) return 'description not reviewed';
    return null;
}

async function describeSeries(root: string, series: AuthoredSeries): Promise<string> {
    const lines = [`${series.id}, version ${series.version}, ${photographs(series.photoIds.length)}`];
    const marks = await Promise.all(series.photoIds.map((photoId) => descriptionMark(root, photoId)));
    for (const [index, photoId] of series.photoIds.entries()) {
        for (const chapter of series.chapters.filter((entry) => entry.startPhotoId === photoId)) lines.push(`  Chapter ${chapter.id}: ${chapter.title}`);
        const notes = [
            ...(series.cover?.photoId === photoId ? ['cover'] : []),
            ...(series.openingPhotoId === photoId ? ['opening'] : []),
            ...(marks[index] ? [marks[index]] : []),
        ];
        lines.push(`  ${number(index, series.photoIds.length)}  ${photoId}${notes.length ? `  ${notes.join(', ')}` : ''}`);
    }
    for (const chapter of series.chapters.filter((entry) => !series.photoIds.includes(entry.startPhotoId))) {
        lines.push(`  Chapter ${chapter.id}: ${chapter.title}, which starts on ${chapter.startPhotoId}, a photograph not in the series`);
    }
    return `${lines.join('\n')}\n`;
}

async function describeSite(root: string, kind: 'setSeriesOrder' | 'setFeaturedSeries'): Promise<string> {
    const site = await readAuthoredRecord(root, 'site', 'site');
    const ids = (kind === 'setSeriesOrder' ? site?.seriesOrder : site?.featuredSeriesIds) ?? [];
    const title = kind === 'setSeriesOrder' ? 'Work order' : 'Featured series';
    return `${[`${title}, version ${site?.version ?? 0}`, ...ids.map((id, index) => `  ${number(index, ids.length)}  ${id}`)].join('\n')}\n`;
}

function describeConsequence(consequence: Consequence): string {
    switch (consequence.kind) {
        case 'cover-cleared':
            return `Cover cleared: it was ${consequence.fromPhotoId}. Set a new cover before publishing.`;
        case 'focal-point-dropped':
            return `Focal point dropped with the cover ${consequence.fromPhotoId}.`;
        case 'opening-cleared':
            return `Opening photograph cleared: it was ${consequence.fromPhotoId}. Home now opens on the first photograph.`;
        case 'chapter-anchor-moved':
            return `Chapter ${consequence.chapterId} now starts on ${consequence.toPhotoId} instead of ${consequence.fromPhotoId}.`;
    }
}

function refused(error: OrderError): CommandResult {
    const exitCode = error.code === 'version-conflict' || error.code === 'authored-locked' ? 3 : 1;
    return { exitCode, output: `Error (${error.code}): ${error.message}\n` };
}

function focalPoint(focal: FocalPoint): FocalPoint {
    const inRange = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
    if (!inRange(focal.x) || !inRange(focal.y)) throw new UsageError('--focal takes x,y, each from 0 to 1.');
    return { x: focal.x, y: focal.y };
}

type Converted = { op: SequenceOp } | { error: OrderError };
type EditCommand = Exclude<SequenceCommand, { command: 'show' }>;

/**
 * The operation a command asks for, with `--to N` turned into an anchor
 * against `record`: the one read the version check is taken from too.
 */
function toOp(command: EditCommand, record: AuthoredSeries | null): Converted {
    switch (command.command) {
        case 'set':
            return { op: { kind: 'setSequence', seriesId: command.seriesId, photoIds: command.photoIds } };
        case 'insert':
        case 'move': {
            const { at } = command;
            if (typeof at === 'string' || 'after' in at) return { op: { kind: command.command, seriesId: command.seriesId, photoId: command.photoId, at } };
            if (!Number.isInteger(at.to) || at.to < 1) throw new UsageError('--to takes a position from 1.');
            if (!record) return { error: { code: 'unknown-series', recordId: command.seriesId, field: 'seriesId', message: `There is no series ${command.seriesId}.` } };
            const version = command.expectVersion ?? record.version;
            if (version !== record.version) {
                // The anchor comes from this read, so it only stands for N at the version this read found.
                return { error: { code: 'version-conflict', recordId: command.seriesId, message: `The series record ${command.seriesId} is at version ${record.version}, not ${version}. Read it again and retry.` } };
            }
            const placement = placementAt(record.photoIds, command.photoId, at.to);
            if (!placement) {
                const length = record.photoIds.filter((id) => id !== command.photoId).length + 1;
                return { error: { code: 'position-out-of-range', recordId: command.seriesId, field: 'at', message: `Position ${at.to} is outside the sequence, which would hold ${photographs(length)}.` } };
            }
            return { op: { kind: command.command, seriesId: command.seriesId, photoId: command.photoId, at: placement } };
        }
        case 'remove':
            return { op: { kind: 'remove', seriesId: command.seriesId, photoId: command.photoId } };
        case 'cover': {
            const { focal } = command;
            return {
                op: {
                    kind: 'setCover',
                    seriesId: command.seriesId,
                    photoId: command.photoId,
                    ...(focal === undefined ? {} : { focalPoint: focal === 'clear' ? null : focalPoint(focal) }),
                },
            };
        }
        case 'opening':
            return { op: { kind: 'setOpeningPhoto', seriesId: command.seriesId, photoId: command.photoId } };
        case 'chapter-add':
            if (!/\S/.test(command.title)) throw new UsageError('chapter add needs a title.');
            return { op: { kind: 'addChapter', seriesId: command.seriesId, title: command.title, startPhotoId: command.startPhotoId } };
        case 'chapter-move':
            return { op: { kind: 'moveChapterStart', seriesId: command.seriesId, chapterId: command.chapterId, startPhotoId: command.startPhotoId } };
        case 'chapter-remove':
            return { op: { kind: 'removeChapter', seriesId: command.seriesId, chapterId: command.chapterId } };
        case 'series-order':
            return { op: { kind: 'setSeriesOrder', seriesIds: command.seriesIds } };
        case 'series-featured':
            return { op: { kind: 'setFeaturedSeries', seriesIds: command.seriesIds } };
    }
}

/** The record a command changes, read once: the series, or the site record for the two site commands. */
async function readTarget(root: string, command: EditCommand): Promise<{ series: AuthoredSeries | null; version: number }> {
    if ('seriesIds' in command) return { series: null, version: (await readAuthoredRecord(root, 'site', 'site'))?.version ?? 0 };
    const series = await readAuthoredRecord(root, 'series', command.seriesId);
    return { series, version: series?.version ?? 0 };
}

async function runCommand(layer: LayerHandle, command: SequenceCommand): Promise<CommandResult> {
    const root = path.resolve(layer.dataRoot);
    if (command.command === 'show') {
        const series = await readAuthoredRecord(root, 'series', command.seriesId);
        if (!series) return refused({ code: 'unknown-series', recordId: command.seriesId, field: 'seriesId', message: `There is no series ${command.seriesId}.` });
        return { exitCode: 0, output: await describeSeries(root, series) };
    }
    if (command.expectVersion !== undefined && (!Number.isInteger(command.expectVersion) || command.expectVersion < 0)) {
        throw new UsageError('--expect-version takes a version from 0.');
    }

    // One read gives both the --to anchor and the default --expect-version, so a write after it fails as version-conflict.
    const target = await readTarget(root, command);
    const converted = toOp(command, target.series);
    if ('error' in converted) return refused(converted.error);
    const { op } = converted;
    const expectedVersion = command.expectVersion ?? target.version;

    const result = await applySequenceOp({ dataRoot: root }, op, { expectedVersion, actor: EDITOR, waitMs: layer.waitMs });
    if (!result.ok) return refused(result.error);

    const notes = result.changed ? result.consequences.map(describeConsequence) : ['No change.'];
    let after: string;
    if ('seriesId' in op) {
        const series = await readAuthoredRecord(root, 'series', op.seriesId);
        after = series ? await describeSeries(root, series) : '';
    } else {
        after = await describeSite(root, op.kind);
    }
    return { exitCode: 0, output: `${notes.map((line) => `${line}\n`).join('')}${after}` };
}

/** Run one command. Never throws: every outcome is an exit code and the text to print. */
export async function runSequenceCommand(layer: LayerHandle, command: SequenceCommand): Promise<CommandResult> {
    try {
        return await runCommand(layer, command);
    } catch (error) {
        if (error instanceof UsageError) return { exitCode: 2, output: `Usage error: ${error.message}\n` };
        return { exitCode: 4, output: `Error: ${(error as Error).message}\n` };
    }
}
