import path from 'node:path';
import { parseArgs } from 'node:util';
import { PHOTO_ID_RE } from '../identity/ids';
import type { PublishResult } from './publish';
import type { PlacementArg, SequenceCommand } from './sequence-commands';
import type { Issue } from './types';
import { catalogPaths } from './working-layer';

/**
 * The argv parsing and report text of scripts/photos.ts's catalog commands,
 * #13 slices B and D, kept here so tests can run them in-process. Nothing but
 * the CLI and its tests imports this module.
 */

export class UsageError extends Error {}

/** Parse flags strictly: an unknown flag, a stray argument, or a missing value is a usage error. */
export function strictly<T>(parse: () => T): T {
    try {
        return parse();
    } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : String(error));
    }
}

export function photoIdArg(arg: string): string {
    if (!PHOTO_ID_RE.test(arg)) throw new UsageError(`${arg} is not a photo ID.`);
    return arg;
}

/** `--expect-version`: the version the record must be at, the current one when omitted. */
function expectVersionArg(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) throw new UsageError('--expect-version takes a version from 0.');
    return Number(value);
}

/** Where insert and move put a photo: exactly one of --start, --end, --after <photoId>, and --to <N>. */
function placementArg(values: { start?: boolean; end?: boolean; after?: string; to?: string }): PlacementArg {
    const given = [values.start === true, values.end === true, values.after !== undefined, values.to !== undefined].filter(Boolean).length;
    if (given !== 1) throw new UsageError('Place the photo with exactly one of --start, --end, --after <photoId>, and --to <N>.');
    if (values.start) return 'start';
    if (values.end) return 'end';
    if (values.after !== undefined) return { after: photoIdArg(values.after) };
    if (!/^\d+$/.test(values.to ?? '')) throw new UsageError('--to takes a position from 1.');
    return { to: Number(values.to) };
}

/** `--focal <x>,<y>`, each from 0 to 1. */
function focalArg(value: string): { x: number; y: number } {
    const match = /^\s*([0-9.]+)\s*,\s*([0-9.]+)\s*$/.exec(value);
    const [x, y] = match ? [Number(match[1]), Number(match[2])] : [Number.NaN, Number.NaN];
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) throw new UsageError('--focal takes x,y, each from 0 to 1, such as --focal 0.5,0.4.');
    return { x, y };
}

/** One positional count, or a usage error that names the form. */
function exactly(positionals: string[], n: number, form: string): string[] {
    if (positionals.length !== n) throw new UsageError(`Usage: photos ${form}`);
    return positionals;
}

/** Parsed flags and positionals. Each command reads only the flags it declares. */
interface Parsed {
    values: Record<string, string | boolean | undefined>;
    positionals: string[];
}

type Options = NonNullable<Parameters<typeof parseArgs>[0]>['options'];

/** Strict parsing with --expect-version, which every changing command takes. */
function parseOrder(args: string[], options: Options = {}): Parsed {
    return strictly(() => parseArgs({ args, options: { 'expect-version': { type: 'string' }, ...options }, allowPositionals: true, strict: true })) as Parsed;
}

const text = (value: string | boolean | undefined): string | undefined => (typeof value === 'string' ? value : undefined);

export function sequenceArgs(args: string[]): SequenceCommand {
    const [sub, ...rest] = args;
    const expectVersion = (values: Parsed['values']) => expectVersionArg(text(values['expect-version']));
    switch (sub) {
        case 'show': {
            const { values, positionals } = parseOrder(rest);
            if (values['expect-version'] !== undefined) throw new UsageError('sequence show takes no --expect-version.');
            const [seriesId] = exactly(positionals, 1, 'sequence show <seriesId>');
            return { command: 'show', seriesId };
        }
        case 'set': {
            const { values, positionals } = parseOrder(rest);
            if (positionals.length < 1) throw new UsageError('Usage: photos sequence set <seriesId> <photoId>...');
            const [seriesId, ...photoIds] = positionals;
            return { command: 'set', seriesId, photoIds: photoIds.map(photoIdArg), expectVersion: expectVersion(values) };
        }
        case 'insert':
        case 'move': {
            const { values, positionals } = parseOrder(rest, { start: { type: 'boolean' }, end: { type: 'boolean' }, after: { type: 'string' }, to: { type: 'string' } });
            const [seriesId, photoId] = exactly(positionals, 2, `sequence ${sub} <seriesId> <photoId> (--start | --end | --after <photoId> | --to <N>)`);
            const at = placementArg({ start: values.start === true, end: values.end === true, after: text(values.after), to: text(values.to) });
            return { command: sub, seriesId, photoId: photoIdArg(photoId), at, expectVersion: expectVersion(values) };
        }
        case 'remove': {
            const { values, positionals } = parseOrder(rest);
            const [seriesId, photoId] = exactly(positionals, 2, 'sequence remove <seriesId> <photoId>');
            return { command: 'remove', seriesId, photoId: photoIdArg(photoId), expectVersion: expectVersion(values) };
        }
        case 'cover': {
            const { values, positionals } = parseOrder(rest, { focal: { type: 'string' }, 'clear-focal': { type: 'boolean' } });
            const [seriesId, photoId] = exactly(positionals, 2, 'sequence cover <seriesId> <photoId> [--focal <x>,<y> | --clear-focal]');
            const focal = text(values.focal);
            if (focal !== undefined && values['clear-focal'] === true) throw new UsageError('--focal and --clear-focal don\'t go together.');
            const point = values['clear-focal'] === true ? 'clear' as const : focal === undefined ? undefined : focalArg(focal);
            return { command: 'cover', seriesId, photoId: photoIdArg(photoId), ...(point === undefined ? {} : { focal: point }), expectVersion: expectVersion(values) };
        }
        case 'opening': {
            const { values, positionals } = parseOrder(rest, { clear: { type: 'boolean' } });
            const form = 'sequence opening <seriesId> (<photoId> | --clear)';
            if (values.clear === true) {
                const [seriesId] = exactly(positionals, 1, form);
                return { command: 'opening', seriesId, photoId: null, expectVersion: expectVersion(values) };
            }
            const [seriesId, photoId] = exactly(positionals, 2, form);
            return { command: 'opening', seriesId, photoId: photoIdArg(photoId), expectVersion: expectVersion(values) };
        }
        case 'chapter': {
            const [action, ...tail] = rest;
            if (action === 'add' || action === 'move') {
                const { values, positionals } = parseOrder(tail, { start: { type: 'string' } });
                const form = action === 'add' ? 'sequence chapter add <seriesId> <title> --start <photoId>' : 'sequence chapter move <seriesId> <chapterId> --start <photoId>';
                const [seriesId, second] = exactly(positionals, 2, form);
                const start = text(values.start);
                if (start === undefined) throw new UsageError(`chapter ${action} needs --start <photoId>.`);
                return action === 'add'
                    ? { command: 'chapter-add', seriesId, title: second, startPhotoId: photoIdArg(start), expectVersion: expectVersion(values) }
                    : { command: 'chapter-move', seriesId, chapterId: second, startPhotoId: photoIdArg(start), expectVersion: expectVersion(values) };
            }
            if (action === 'remove') {
                const { values, positionals } = parseOrder(tail);
                const [seriesId, chapterId] = exactly(positionals, 2, 'sequence chapter remove <seriesId> <chapterId>');
                return { command: 'chapter-remove', seriesId, chapterId, expectVersion: expectVersion(values) };
            }
            throw new UsageError(action ? `Unknown chapter command: ${action}` : 'photos sequence chapter needs add, move, or remove.');
        }
        default:
            throw new UsageError(sub ? `Unknown sequence command: ${sub}` : 'photos sequence needs a command.');
    }
}

export function seriesArgs(args: string[]): SequenceCommand {
    const [sub, ...rest] = args;
    if (sub !== 'order' && sub !== 'featured') throw new UsageError(sub ? `Unknown series command: ${sub}` : 'photos series needs order or featured.');
    const { values, positionals } = parseOrder(rest);
    return { command: sub === 'order' ? 'series-order' : 'series-featured', seriesIds: positionals, expectVersion: expectVersionArg(text(values['expect-version'])) };
}

/** How many issues the CLI prints. The diagnostics file holds every one. */
export const PRINTED_ISSUES = 200;

export const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

export function issueLines(issues: readonly Issue[], rest: string): string[] {
    const lines: string[] = [];
    for (const issue of issues.slice(0, PRINTED_ISSUES)) {
        lines.push(`${issue.severity} ${issue.record.kind} ${issue.record.id} ${issue.field}: ${issue.message} (${issue.code})`);
        if (issue.hint) lines.push(`    ${issue.hint}`);
    }
    if (issues.length > PRINTED_ISSUES) lines.push(`${count(issues.length - PRINTED_ISSUES, 'more issue')} not shown. ${rest}`);
    return lines;
}

/** What the first publish asks of the owner. docs/curation.md's launch checklist has the whole list. */
const LAUNCH_CHECKLIST = [
    'Launch checklist, from docs/curation.md:',
    '  - The cutover milestone has shipped: Home, Work, the series pages, and the Viewer read the catalog (#4, #3, #5, #7), and a rollback works (#15 slice A).',
    '  - Viewer hardening (#9) is recommended first.',
    '  - A preview, this data root copied, published, and served on another port, looks right.',
];

/** The lines `photos publish` prints for a result. */
export function publishReport(result: PublishResult, root: string): string[] {
    const lines = [`[photos] ${result.outcome}: ${result.message}`];
    if (result.candidateId) lines.push(`Candidate: ${result.candidateId}`);
    if (result.revisionId) lines.push(`Active: ${result.revisionId}${result.revisionNumber === null ? '' : `, revision ${result.revisionNumber}`}`);
    if (result.missingRules?.length) lines.push(`Missing rules: ${result.missingRules.join(', ')}`);
    if (result.launch) {
        const { published, gone } = result.launch;
        const leaving = gone === 0 ? 'Every photograph in the library is in it.' : `${count(gone, 'photograph')} in the library ${gone === 1 ? "isn't" : "aren't"} in it, so ${gone === 1 ? 'it leaves' : 'they leave'} the site.`;
        lines.push(`Launch: this revision replaces the legacy Home and Gallery with ${count(published, 'photograph')}. ${leaving}`);
        lines.push(...LAUNCH_CHECKLIST);
        if (result.outcome === 'LAUNCH_CONFIRMATION_REQUIRED') lines.push('Run it again with --confirm-launch to publish it.');
    }
    if (result.reprofiled) {
        const { moved, kept } = result.reprofiled;
        if (moved.length) lines.push(`Moved to the current profile: ${moved.slice(0, PRINTED_ISSUES).join(', ')}${moved.length > PRINTED_ISSUES ? `, and ${moved.length - PRINTED_ISSUES} more` : ''}`);
        if (kept.length) lines.push(`Kept their profile, since the watcher can't rebuild them: ${kept.slice(0, PRINTED_ISSUES).join(', ')}${kept.length > PRINTED_ISSUES ? `, and ${kept.length - PRINTED_ISSUES} more` : ''}`);
    }
    const diagnostics = result.candidateId ? path.relative(root, path.join(catalogPaths(root).diagnosticsDir, `${result.candidateId}.json`)) : null;
    lines.push(...issueLines(result.issues, diagnostics ? `All of them are in ${diagnostics}.` : ''));
    return lines;
}

// Placeholder until the flag check lands: parses strictly, like the commands do.
export function parseFlags(config: Parameters<typeof parseArgs>[0]): ReturnType<typeof parseArgs> {
    return strictly(() => parseArgs({ ...config, strict: true }));
}
