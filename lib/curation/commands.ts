import path from 'node:path';
import { parseArgs } from 'node:util';
import { references, ReferenceScanError } from '../catalog/references';
import { REVISION_ID_RE, SERIES_ID_RE } from '../catalog/schema';
import type { AuthoredPhoto } from '../catalog/types';
import { readActivePointer, readAuthoredRecord } from '../catalog/working-layer';
import { isLibraryPath } from '../identity/decisions';
import { PHOTO_ID_RE } from '../identity/ids';
import { readRegistry } from '../identity/registry';
import type { Registry } from '../identity/types';
import { dataRootStatus } from '../storage/config';
import { realpathLoose } from '../storage/fsx';
import {
    ACTION_EXIT_CODES,
    approveEvent,
    dismissEvent,
    editEvent,
    placementText,
    reopenEvent,
    retryEvent,
    type ActionInput,
    type ActionOutcome,
    type Choices,
} from './actions';
import { currentProfileId } from '../identity/profile';
import { EVENT_ID_RE, EVENT_STATUSES, FAILURE_TEXT, needsJudgment, shortPhotoId, waitingReason, type CurationEvent, type CurationEventStatus, type Placement } from './events';
import { placedItems } from './placement';
import { draftPlanText, readDraftPlan, replacedBy } from './pins';
import { archiveMissing, bindReplacement, confirmReplacement, leaveInDraft, linkedNewItems } from './resolutions';
import { decisionState, pendingMergeOf, type DecisionState } from './binds';
import { EventUnusableError, listEvents, readEvent, type EventProblem } from './repository';
import { MAX_DESCRIPTION_LENGTH, MAX_REASON_LENGTH, ownerText } from './text';

/**
 * `npm run photos -- curation <command>`: the inbox as a local CLI, the
 * approved first safe slice. Handlers take parsed arguments and return the
 * exit code and the text to print, which never names an absolute path.
 *
 * Exit codes: 0 done, 1 refused (wrong type or state, an unknown series, a
 * rule #8 enforces), 2 usage, 3 stale (the event, the active revision, the
 * source, or a record moved since it was shown, a busy lock, or a data root
 * that isn't ready), 4 storage (a damaged or unreadable file).
 */

export interface CommandResult {
    exitCode: 0 | 1 | 2 | 3 | 4;
    output: string;
}

export interface CurationContext {
    /** Null when PHOTOGRAPHY_DATA_DIR is unset. */
    dataRoot: string | null;
    /** For scrubbing output. */
    libraryRoot?: string | null;
    actor: string;
    clock?: () => number;
    waitMs?: number;
}

export type ListFilter = CurationEventStatus | 'active' | 'all';

export type CurationCommand =
    | { command: 'list'; filter: ListFilter; json: boolean }
    | { command: 'show'; eventId: string; json: boolean }
    | { command: 'edit' | 'approve'; eventId: string; version: number; base?: string | null; choices: Choices }
    | { command: 'defer' | 'reopen' | 'retry'; eventId: string; version: number; base?: string | null; reason?: string }
    | { command: 'confirm'; eventId: string; version: number; base?: string | null }
    | { command: 'archive'; eventId: string; version: number; base?: string | null; reason?: string }
    | { command: 'bind'; eventId: string; version: number; base?: string | null; path?: string; reason?: string }
    | { command: 'dismiss'; eventId: string; version: number; base?: string | null; reason: string };

/** The program the CLI runs as when none is given: the source under tsx. */
export const DEFAULT_PROGRAM = 'npx tsx scripts/photos.ts';

/** The curation lines of the usage text, under the name `program` was started as (10C's PROGRAM). */
export function curationUsage(program: string = DEFAULT_PROGRAM): string {
    return `  ${program} curation list [--status <status> | --all] [--json]
  ${program} curation show <eventId> [--json]
  ${program} curation edit <eventId> --version <n> [--series <seriesId> | --unassigned]
        [--start | --end | --after <photoId>] [--description <text> | --decorative | --clear-description]
  ${program} curation approve <eventId> --version <n> [the same choices as edit]
  ${program} curation defer <eventId> --version <n> [--reason <text>]
  ${program} curation dismiss <eventId> --version <n> --reason <text>
  ${program} curation retry <eventId> --version <n> [--reason <text>]
  ${program} curation reopen <eventId> --version <n> [--reason <text>]
  ${program} curation confirm <eventId> --version <n>
        Confirm new asset revision: a replacement's photo record takes the new bytes, once all derivatives succeed.
        To keep the revision the draft pins instead, leave it in draft with defer. On a confirmed
        replacement, reopen and then defer put back the revision the confirm replaced, while that
        confirm is still the inbox's latest change to the photo's revision; reopen and show say
        what defer will do.
  ${program} curation bind <eventId> --version <n> [--path <library path>] [--reason <text>]
        Bind an intentional replacement to a missing photograph: the file at --path, or the other bytes found at its last path.
  ${program} curation archive <eventId> --version <n> [--reason <text>]
        Archive after removing series references: the takedown of a missing photograph, which photos publish then makes public.
    Every item command also takes --base <revisionId|none> (the active revision it was reviewed against) and --actor <name>.
    approve, confirm, and archive need --base once a revision is active.`;
}

export class CurationUsageError extends Error {}

const usage = (message: string): never => {
    throw new CurationUsageError(message);
};

const ITEM_COMMANDS = ['edit', 'approve', 'defer', 'dismiss', 'retry', 'reopen', 'confirm', 'bind', 'archive'] as const;

function text(value: string, field: string, max: number): string {
    const checked = ownerText(value, { field, max });
    if (!checked.ok) usage(checked.problem);
    return (checked as { text: string }).text;
}

/** Parse `curation <command> ...`. Throws CurationUsageError for anything that isn't a command. */
export function parseCurationArgs(args: readonly string[]): CurationCommand {
    const [command, ...rest] = args;
    let parsed: ReturnType<typeof parseArgs>;
    try {
        parsed = parseArgs({
            args: [...rest],
            options: {
                json: { type: 'boolean' },
                status: { type: 'string' },
                all: { type: 'boolean' },
                version: { type: 'string' },
                base: { type: 'string' },
                series: { type: 'string' },
                unassigned: { type: 'boolean' },
                start: { type: 'boolean' },
                end: { type: 'boolean' },
                after: { type: 'string' },
                description: { type: 'string' },
                decorative: { type: 'boolean' },
                'clear-description': { type: 'boolean' },
                reason: { type: 'string' },
                actor: { type: 'string' },
                path: { type: 'string' },
            },
            allowPositionals: true,
            strict: true,
        });
    } catch (error) {
        return usage(error instanceof Error ? error.message : String(error));
    }
    const values = parsed.values as Record<string, string | boolean | undefined>;
    const positionals = parsed.positionals;
    const given = (name: string) => values[name] !== undefined;
    const only = (allowed: readonly string[]) => {
        for (const name of Object.keys(values)) if (!allowed.includes(name)) usage(`--${name} doesn't go with curation ${command}.`);
    };

    if (command === 'list') {
        only(['json', 'status', 'all']);
        if (positionals.length > 0) usage('curation list takes no event ID.');
        if (given('status') && given('all')) usage("--status and --all don't go together.");
        const status = values.status as string | undefined;
        if (status !== undefined && !(EVENT_STATUSES as readonly string[]).includes(status)) usage(`--status takes one of ${EVENT_STATUSES.join(', ')}.`);
        return { command, filter: values.all ? 'all' : (status as CurationEventStatus | undefined) ?? 'active', json: values.json === true };
    }
    if (command === 'show') {
        only(['json']);
        if (positionals.length !== 1) usage('curation show needs one event ID.');
        if (!EVENT_ID_RE.test(positionals[0])) usage(`${positionals[0]} is not an event ID.`);
        return { command, eventId: positionals[0], json: values.json === true };
    }
    if (!(ITEM_COMMANDS as readonly string[]).includes(command ?? '')) {
        return usage(command ? `Unknown curation command: ${command}` : 'photos curation needs a command.');
    }
    const choiceFlags = ['series', 'unassigned', 'start', 'end', 'after', 'description', 'decorative', 'clear-description'];
    const common = ['version', 'base', 'actor'];
    only(command === 'edit' || command === 'approve' ? [...common, ...choiceFlags] : command === 'confirm' ? common : command === 'bind' ? [...common, 'reason', 'path'] : [...common, 'reason']);
    if (positionals.length !== 1) usage(`curation ${command} needs one event ID.`);
    const [eventId] = positionals;
    if (!EVENT_ID_RE.test(eventId)) usage(`${eventId} is not an event ID.`);
    const versionText = values.version as string | undefined;
    if (versionText === undefined) usage(`curation ${command} needs --version <n>, the version list or show printed.`);
    if (!/^[1-9]\d*$/.test(versionText as string)) usage('--version takes a version from 1.');
    const version = Number(versionText);
    const baseText = values.base as string | undefined;
    if (baseText !== undefined && baseText !== 'none' && !REVISION_ID_RE.test(baseText)) usage('--base takes a revision ID or none.');
    const base = baseText === undefined ? {} : { base: baseText === 'none' ? null : baseText };
    const item = { eventId, version, ...base };

    if (command === 'edit' || command === 'approve') {
        const choices: Choices = {};
        if (given('series') && given('unassigned')) usage("--series and --unassigned don't go together.");
        if (given('series')) {
            const seriesId = values.series as string;
            if (!SERIES_ID_RE.test(seriesId)) usage(`${seriesId} is not a series ID.`);
            choices.seriesId = seriesId;
        }
        if (values.unassigned) choices.seriesId = null;
        const placements = ['start', 'end', 'after'].filter(given);
        if (placements.length > 1) usage('Pass one of --start, --end, and --after.');
        if (values.start) choices.placement = 'start';
        if (values.end) choices.placement = 'end';
        if (given('after')) {
            const after = values.after as string;
            if (!PHOTO_ID_RE.test(after)) usage(`${after} is not a photo ID.`);
            choices.placement = { after };
        }
        if (choices.placement !== undefined && choices.seriesId === null) usage('A photograph left unassigned has no position.');
        const descriptions = ['description', 'decorative', 'clear-description'].filter(given);
        if (descriptions.length > 1) usage('Pass one of --description, --decorative, and --clear-description.');
        if (given('description')) choices.description = { kind: 'described', text: text(values.description as string, '--description', MAX_DESCRIPTION_LENGTH) };
        if (values.decorative) choices.description = { kind: 'decorative' };
        if (values['clear-description']) {
            if (command === 'approve') usage('--clear-description goes with curation edit.');
            choices.description = null;
        }
        return { command, ...item, choices };
    }
    if (command === 'confirm') return { command, ...item };
    const reason = values.reason === undefined ? undefined : text(values.reason as string, '--reason', MAX_REASON_LENGTH);
    if (command === 'dismiss') {
        if (reason === undefined) usage('curation dismiss needs --reason <text>.');
        return { command, ...item, reason: reason as string };
    }
    if (command === 'bind') {
        const target = values.path as string | undefined;
        if (target !== undefined && !isLibraryPath(target)) usage(`--path takes a path relative to the library, such as harbor/landscape.jpg.`);
        return { command, ...item, ...(target === undefined ? {} : { path: target }), ...(reason === undefined ? {} : { reason }) };
    }
    if (command === 'archive') return { command, ...item, ...(reason === undefined ? {} : { reason }) };
    return { command: command as 'defer' | 'reopen' | 'retry', ...item, ...(reason === undefined ? {} : { reason }) };
}

/** The actor a command records: --actor, then PHOTOS_ACTOR, then `curator:cli`. */
export function actorFrom(args: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): string {
    const index = args.indexOf('--actor');
    const flag = index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith('--actor='))?.slice('--actor='.length);
    const actor = (flag ?? env.PHOTOS_ACTOR ?? '').trim();
    if (actor === '') return 'curator:cli';
    return text(actor, '--actor', 100);
}

/** Replace the data root and the library root in `output`, as given and as resolved, so nothing printed names a host path. */
export function scrub(output: string, [dataRootPath, libraryRootPath]: readonly (string | null | undefined)[]): string {
    const pairs: [string, string][] = [];
    for (const [root, label] of [[dataRootPath, '<data root>'], [libraryRootPath, '<library>']] as const) {
        if (typeof root !== 'string' || root.length <= 1) continue;
        for (const variant of new Set([path.resolve(root), realpathLoose(root)])) if (variant.length > 1) pairs.push([variant, label]);
    }
    let scrubbed = output;
    // Longest first, so a library inside the data root, or a resolved path that extends the given one, goes whole.
    for (const [root, label] of pairs.sort((a, b) => b[0].length - a[0].length)) scrubbed = scrubbed.split(root).join(label);
    return scrubbed;
}

/** C0, C1, DEL, the bidi controls, line and paragraph separators, and zero-width characters. */
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu;

/**
 * Every character that could forge a line or rewrite the terminal, as `\n`
 * or `\uXXXX`.
 */
function escapeUnprintable(text: string): string {
    return text.replace(UNPRINTABLE, (char) => (char === '\n' ? '\\n' : `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`));
}

/**
 * A path or name for text output: backslashes doubled, so a literal `\n` in
 * a name never reads as an escaped newline, then everything unprintable
 * escaped. File names come from the owner's library, synced files included,
 * and #10 doesn't filter them.
 */
export function printable(field: string): string {
    return escapeUnprintable(field.replace(/\\/g, '\\\\'));
}

/**
 * The last pass over all output, line by line, keeping the line breaks
 * between them. It leaves backslashes alone, so the fields printable()
 * already escaped and JSON output both stay as they are: what it escapes are
 * JSON escapes too.
 */
function printableLines(output: string): string {
    return output.split('\n').map(escapeUnprintable).join('\n');
}

const STATUS_WIDTH = 8;
const TYPE_WIDTH = 18;

function listLine(event: CurationEvent, waiting: string | null = null, placed: string | null = null, unplaced: string | null = null): string {
    const line = `${`${event.id}@${event.version}`.padEnd(32)}  ${event.type.padEnd(TYPE_WIDTH)}  ${event.status.padEnd(STATUS_WIDTH)}  ${shortPhotoId(event.photoId).padEnd(11)}  ${printable(event.derivedFacts.sourcePath)}`;
    return `${line}${waiting === null ? '' : `  waiting: ${waiting}`}${placed === null ? '' : `  placed: ${placed}`}${unplaced === null ? '' : `  unplaced: approved into ${unplaced}, but no series or the live revision holds its photo now`}`;
}

/**
 * The default list leaves out items settled by placement and takes in
 * approvals whose photo nothing holds now (unplacedApproval()); `--status`
 * and `--all` go by the stored status.
 */
function matches(filter: ListFilter, event: CurationEvent, placed: boolean, unplaced: boolean): boolean {
    if (filter === 'all') return true;
    if (filter === 'active') return unplaced || (!placed && (event.status === 'open' || event.status === 'failed' || event.status === 'deferred'));
    return event.status === filter;
}

const unknownPlacementLine = (error: ReferenceScanError) => `Can't tell which new photographs are placed, since ${error.file} can't be used (${error.reason}), so every item counts by its stored status: none reads as already placed or as no longer placed.`;

/** What `show` prints for an approval whose photo nothing holds now: the two commands that put it back, ready to run. */
function unplacedLines(event: CurationEvent, series: string, active: string | null): string[] {
    const base = active ?? 'none';
    return [
        `No longer placed: it was approved into ${series}, but no series or the live revision holds its photo now. The photo record stays in the draft, unassigned. To put it back at the end of ${series}, run:`,
        `  curation reopen ${event.id} --version ${event.version} --base ${base}`,
        `  curation approve ${event.id} --version ${event.version + 1} --series ${series} --base ${base}`,
    ];
}

const items = (n: number) => `${n} item${n === 1 ? '' : 's'}`;

function problemLine(problem: EventProblem): string {
    return `Unreadable: ${problem.id} (${problem.reason}): ${printable(problem.message)}`;
}

async function list(root: string, command: Extract<CurationCommand, { command: 'list' }>): Promise<CommandResult> {
    const { events, problems } = await listEvents(root);
    const registry = events.length > 0 ? await readRegistry(root).catch(() => null) : null;
    const profileId = currentProfileId();
    const waiting = new Map(events.map((event) => [event.id, waitingReason(event, registry, profileId)]));
    const { placed, unplaced, unknown } = await placedItems(root, events);
    const shown = events.filter((event) => matches(command.filter, event, placed.has(event.id), unplaced.has(event.id)));
    const judgment = events.filter((event) => needsJudgment(event, waiting.get(event.id) ?? null, placed.has(event.id))).length;
    const waitingCount = [...waiting.values()].filter((reason) => reason !== null).length;
    if (command.json) {
        const summary = shown.map((event) => ({ id: event.id, version: event.version, type: event.type, status: event.status, photoId: event.photoId, sourcePath: event.derivedFacts.sourcePath, observedAt: event.observedAt, waiting: waiting.get(event.id) ?? null, placed: placed.get(event.id) ?? null, unplaced: unplaced.get(event.id) ?? null }));
        return { exitCode: problems.length > 0 ? 4 : 0, output: `${JSON.stringify({ needsJudgment: judgment, waiting: waitingCount, placed: placed.size, unplaced: unplaced.size, total: events.length, events: summary, problems }, null, 2)}\n` };
    }
    const lines: string[] = [];
    if (events.length === 0 && problems.length === 0) {
        lines.push('Curation inbox: empty. Nothing requires judgment.');
    } else {
        lines.push(`Curation inbox: ${items(judgment)} ${judgment === 1 ? 'requires' : 'require'} judgment${waitingCount > 0 ? `, ${waitingCount} waiting` : ''}${placed.size > 0 ? `, ${placed.size} already placed` : ''}${unplaced.size > 0 ? `, ${unplaced.size} approved but no longer placed` : ''}, ${events.length} in all.`);
        if (unknown !== null) lines.push(unknownPlacementLine(unknown));
        if (shown.length === 0) {
            lines.push(command.filter === 'active' && placed.size > 0
                ? `Nothing matches open, failed, or deferred but the ${items(placed.size)} already placed. --all lists them.`
                : `Nothing matches ${command.filter === 'active' ? 'open, failed, or deferred' : command.filter}.`);
        }
        for (const event of shown) lines.push(listLine(event, waiting.get(event.id) ?? null, placed.get(event.id) ?? null, unplaced.get(event.id) ?? null));
    }
    for (const problem of problems) lines.push(problemLine(problem));
    return { exitCode: problems.length > 0 ? 4 : 0, output: `${lines.join('\n')}\n` };
}

const placementOf = (placement: Placement) => placementText(placement);

function identityLines(event: CurationEvent, registry: Registry | null): string[] {
    if (event.photoId === null) return ['Stable photo identity: none yet. This file has no photo ID.'];
    const photo = registry?.photos[event.photoId];
    if (!photo) return [`Stable photo identity: ${event.photoId}, which the registry no longer holds.`];
    const lines = [`Stable photo identity: ${event.photoId}, source ${photo.sourceHealth}${photo.mergedInto ? `, merged into ${photo.mergedInto}` : ''}${photo.duplicateOf ? `, a copy of ${photo.duplicateOf}` : ''}`];
    if (photo.source.observedRevision !== event.assetRevision) lines.push(`  Its source now holds ${photo.source.observedRevision}, not this event's revision.`);
    const revision = event.assetRevision ? photo.revisions[event.assetRevision] : undefined;
    const profiles = revision ? Object.entries(revision.profiles) : [];
    // A build's error text may name a host path, so only its state and attempts are shown.
    lines.push(profiles.length === 0 ? 'Derivatives: none built yet.' : `Derivatives: ${profiles.map(([profileId, entry]) => `${profileId} ${entry.state}${entry.state === 'failed' ? ` after ${entry.attempts} attempt${entry.attempts === 1 ? '' : 's'}` : ''}`).join(', ')}`);
    return lines;
}

async function referenceLines(root: string, photoId: string | null): Promise<string[]> {
    if (photoId === null) return ['Published references: none, since it has no photo ID.'];
    try {
        const holders = (await references(root))
            .filter((entry) => entry.photoId === photoId && (entry.source === 'active-revision' || entry.source === 'working-layer-series'))
            .map((entry) => (entry.source === 'active-revision' ? `the active revision ${entry.holder}` : `the draft series ${entry.holder}`));
        const unique = [...new Set(holders)];
        return [`Published references: ${unique.length === 0 ? 'none' : unique.join(', ')}`];
    } catch (error) {
        if (error instanceof ReferenceScanError) return [`Published references: can't tell, since ${error.file} can't be used (${error.reason}).`];
        throw error;
    }
}

function suggestionLines(event: CurationEvent): string[] {
    const { series, placement } = event.suggestions;
    if (series === null && placement === null) return ['Reviewable suggestion: none for this type.'];
    const lines = ['Reviewable suggestion (generated, not reviewed):'];
    if (series) {
        lines.push(`  Suggested series: ${series.value ?? 'Leave unassigned'} (${series.confidence}, ${series.producedBy}, ${series.producedAt})`);
        for (const line of series.evidence) lines.push(`    ${printable(line)}`);
    }
    if (placement) {
        lines.push(`  Proposed sequence position: ${placementOf(placement.value)} (${placement.confidence}, ${placement.producedBy}, ${placement.producedAt})`);
        for (const line of placement.evidence) lines.push(`    ${printable(line)}`);
    }
    lines.push('  Draft description: none suggested.');
    return lines;
}

function editLines(event: CurationEvent): string[] {
    const edits = event.edits;
    if (!edits) return ['Your edits: none.'];
    const parts = [
        ...(edits.seriesId === undefined ? [] : [`series ${edits.seriesId ?? 'Leave unassigned'}`]),
        ...(edits.placement === undefined ? [] : [`position ${placementOf(edits.placement)}`]),
        ...(edits.description === undefined ? [] : [edits.description === null ? 'description cleared' : edits.description.kind === 'decorative' ? 'decorative' : `description "${printable(edits.description.text)}"`]),
    ];
    return [`Your edits: ${parts.join(', ') || 'none'} (${printable(edits.editedBy)}, ${edits.editedAt})`];
}

function factLines(event: CurationEvent): string[] {
    const facts = event.derivedFacts;
    const lines = [`Source: ${printable(facts.sourcePath)}${facts.fromPath ? `, from ${printable(facts.fromPath)}` : ''} (${facts.factType})`];
    const details = [
        ...(facts.capturedDate ? [`captured ${facts.capturedDate}`] : facts.capturedDate === null ? ['no capture date'] : []),
        ...(facts.width && facts.height ? [`${facts.width}x${facts.height}`] : []),
        ...(facts.sourceFormat ? [facts.sourceFormat] : []),
    ];
    if (details.length > 0) lines.push(`Derived metadata: ${details.join(', ')}`);
    if (facts.candidates?.length) lines.push(`Candidates: ${facts.candidates.join(', ')}`);
    if (facts.duplicateOf) lines.push(`Same bytes as ${facts.duplicateOf}.`);
    if (facts.failure) lines.push(`Failure: ${facts.failure}. ${FAILURE_TEXT[facts.failure]}`);
    return lines;
}

const CANDIDATE_FAILURE_TEXT = {
    superseded: 'the source changed again before it was built',
    integrity: "a set in place for these bytes doesn't match its manifest",
    undecodable: "the new file can't be decoded",
    build: 'building it failed',
} as const;

/** #17's lines for a replacement: its derivative set, what the photo record pins now, and what confirming keeps. */
async function replacementLines(root: string, event: CurationEvent, registry: Registry | null): Promise<string[]> {
    if (event.type !== 'replacement' || event.photoId === null) return [];
    const candidate = event.candidate;
    const set = !candidate
        ? 'still building. Use the new bytes only after all derivatives succeed.'
        : candidate.state === 'ready'
            ? `ready under ${candidate.profileId}, every derivative built and checked.`
            : `failed under ${candidate.profileId}: ${CANDIDATE_FAILURE_TEXT[candidate.failure ?? 'build']}.`;
    let pinned: string;
    // The revision the record pins, null for no record, undefined when it can't be read.
    let revision: string | null | undefined;
    let photoRecord: AuthoredPhoto | null = null;
    try {
        const record = await readAuthoredRecord(root, 'photo', event.photoId);
        photoRecord = record;
        revision = record ? record.assetRevision : null;
        pinned = record ? record.assetRevision : 'nothing yet: the photograph has no photo record in the working layer';
    } catch {
        pinned = "can't tell: its photo record can't be read";
    }
    // The plan leaveInDraft() acts on, so this says what defer does now.
    let draft: string;
    try {
        if (revision === undefined || registry === null) throw new Error('unreadable');
        draft = draftPlanText(await readDraftPlan(root, event, async () => photoRecord, registry), replacedBy(event)) ?? '';
    } catch {
        draft = "What leaving it in draft (defer) would do can't be told now, since the photo record or the registry can't be read.";
    }
    return [
        `New derivative set: ${set}`,
        `Photo record pins: ${pinned}`,
        `Confirm new asset revision keeps ${event.photoId}'s series, position, title, description, and story.${draft ? ` ${draft}` : ''}`,
    ];
}

/** What became of the item's latest bind: still waiting for the watcher, or refused, with #10's reason. */
async function bindLines(root: string, event: CurationEvent): Promise<string[]> {
    const bind = event.decisions.findLast((decision) => decision.action === 'bind' && decision.identityDecisionId !== undefined);
    if (!bind?.identityDecisionId) return [];
    const id = bind.identityDecisionId;
    const where = bind.path ? ` for ${printable(bind.path)}` : '';
    const found = await decisionState(root, id).catch((): DecisionState => ({ state: 'unknown' }));
    switch (found.state) {
        case 'pending':
            return [`Bind pending: the watcher applies the decision ${id}${where} on its next pass, unless the file is still changing.`];
        case 'rejected':
            return [`Bind refused: the watcher rejected the decision ${id}${where}: ${printable(found.reason)}. Nothing changed. Bind another file, or settle it another way.`];
        default:
            return [];
    }
}

/** For a new item whose photograph a pending bind merges: why approve refuses it. */
async function pendingMergeLines(root: string, event: CurationEvent): Promise<string[]> {
    if (event.type !== 'new' || event.photoId === null || (event.status !== 'open' && event.status !== 'deferred')) return [];
    const merge = await pendingMergeOf(root, event.photoId).catch(() => null);
    if (merge === null) return [];
    return [`Bind pending: the decision ${merge.decisionId} merges this photograph into ${merge.into} on the watcher's next pass, so approve refuses it until then.`];
}

/**
 * #17's lines for a missing source: that the published output is protected,
 * the files linked to it, and the three ways to settle it.
 */
async function missingLines(root: string, event: CurationEvent, registry: Registry | null): Promise<string[]> {
    if (event.type !== 'missing' || event.photoId === null) return [];
    const photo = registry?.photos[event.photoId];
    const lines = [
        'Published output protected: the active revision keeps serving this photograph from its derivative set, which the source file is no longer needed for. Deleting, moving, or renaming a file never takes a photograph down.',
    ];
    if (event.status !== 'open' && event.status !== 'deferred' && event.status !== 'failed') return lines;
    if (photo?.sourceHealth === 'present' && photo.source.present) {
        lines.push(`Its source is back at ${printable(photo.source.path)}. The watcher closes this item on its next pass.`);
        return lines;
    }
    lines.push(...await bindLines(root, event));
    const linked = registry === null ? [] : await linkedNewItems(root, event.photoId, registry).catch(() => []);
    for (const item of linked) {
        lines.push(`Linked: ${printable(item.derivedFacts.sourcePath)} holds other bytes at its last path, the new photograph ${shortPhotoId(item.photoId)} (${item.id}). curation bind gives them to ${event.photoId}.`);
    }
    lines.push(
        'To settle it:',
        '  Locate or restore source file: put the same file back anywhere in the library, and the watcher closes this item.',
        `  Bind an intentional replacement: curation bind ${event.id}${linked.length === 1 ? '' : ' --path <library path>'}, then confirm the new asset revision on its replacement item.`,
        `  Archive after removing series references: curation archive ${event.id}, then photos publish. That is the takedown. Copies already served as immutable can stay in browsers and caches.`,
    );
    return lines;
}

/** #17's line for a failed build's item. */
function failedBuildLines(event: CurationEvent): string[] {
    if (event.type !== 'processing-failure' || !event.candidate) return [];
    const { candidate } = event;
    if (candidate.state === 'ready') return [`Derivative set: built under ${candidate.profileId}.`];
    return [`Derivative set: failed under ${candidate.profileId}: ${CANDIDATE_FAILURE_TEXT[candidate.failure ?? 'build']}. The previous published image, if any, keeps serving. curation retry builds it again.`];
}

async function show(root: string, command: Extract<CurationCommand, { command: 'show' }>): Promise<CommandResult> {
    let event: CurationEvent | null;
    try {
        event = await readEvent(root, command.eventId);
    } catch (error) {
        if (error instanceof EventUnusableError) return { exitCode: 4, output: `Error (${error.problem.reason}): ${error.message}\n` };
        throw error;
    }
    if (event === null) return { exitCode: 1, output: `Error (not-found): There is no event ${command.eventId}.\n` };
    const active = (await readActivePointer(root))?.revisionId ?? null;
    const registry = await readRegistry(root).catch(() => null);
    const { placed, unplaced, unknown } = await placedItems(root, [event]);
    if (command.json) {
        const placementUnknown = unknown === null ? null : { file: unknown.file, reason: unknown.reason };
        return { exitCode: 0, output: `${JSON.stringify({ event, activeRevisionId: active, placed: placed.get(event.id) ?? null, unplaced: unplaced.get(event.id) ?? null, placementUnknown }, null, 2)}\n` };
    }
    const lines = [
        `${event.id}, version ${event.version}: ${event.type}, ${event.status}`,
        ...identityLines(event, registry),
        ...((reason) => (reason === null ? [] : [`Waiting: ${reason}. Act on it once the set is ready.`]))(waitingReason(event, registry, currentProfileId())),
        ...((reason) => (reason === undefined ? [] : [`Already placed: ${reason}, so it needs no judgment while it stays there.`]))(placed.get(event.id)),
        ...((series) => (series === undefined ? [] : unplacedLines(event, series, active)))(unplaced.get(event.id)),
        ...(unknown === null ? [] : [unknownPlacementLine(unknown)]),
        `Asset revision: ${event.assetRevision ?? 'none'}`,
        ...(await replacementLines(root, event, registry)),
        ...(await missingLines(root, event, registry)),
        ...(await pendingMergeLines(root, event)),
        ...failedBuildLines(event),
        `Observed: ${event.observedAt}${event.lastObservedAt !== event.observedAt ? `, last ${event.lastObservedAt}` : ''}`,
        ...factLines(event),
        ...suggestionLines(event),
        ...editLines(event),
        ...(await referenceLines(root, event.photoId)),
        `Active revision: ${active ?? 'none yet'}`,
        'Published statement remains unchanged. Automatic analysis can draft a revision, but it cannot edit the public series or its order.',
    ];
    if (event.decisions.length > 0) {
        lines.push('Decisions:');
        for (const decision of event.decisions) {
            const extra = [
                ...(decision.seriesId !== undefined ? [decision.seriesId ?? 'unassigned'] : []),
                ...(decision.placement ? [placementOf(decision.placement)] : []),
                ...(decision.reason ? [`"${printable(decision.reason)}"`] : []),
                ...(decision.writes?.length ? [`wrote ${decision.writes.map((entry) => `${entry.record} v${entry.version}`).join(', ')}`] : []),
                ...(decision.identityDecisionId ? [`identity decision ${decision.identityDecisionId}`] : []),
                ...(decision.fromRevision ? [decision.action === 'defer' ? `put back ${decision.fromRevision}` : `in place of ${decision.fromRevision}`] : []),
                ...(decision.path ? [`path ${printable(decision.path)}`] : []),
            ];
            lines.push(`  ${decision.at} ${decision.action} by ${printable(decision.by)}${extra.length ? `: ${extra.join(', ')}` : ''}`);
        }
    }
    lines.push(`To act on it: --version ${event.version} --base ${active ?? 'none'}`);
    return { exitCode: 0, output: `${lines.join('\n')}\n` };
}

function report(outcome: ActionOutcome): CommandResult {
    if (!outcome.ok) return { exitCode: ACTION_EXIT_CODES[outcome.code], output: `Error (${outcome.code}): ${outcome.message}\n` };
    const { event } = outcome;
    return { exitCode: 0, output: `${[...outcome.notes, `${event.id} is ${event.status}, now at version ${event.version}.`].join('\n')}\n` };
}

async function run(context: CurationContext, command: CurationCommand): Promise<CommandResult> {
    if (context.dataRoot === null) return { exitCode: 3, output: 'Error (not-ready): PHOTOGRAPHY_DATA_DIR is not set.\n' };
    const root = path.resolve(context.dataRoot);
    if (command.command === 'list' || command.command === 'show') {
        const status = dataRootStatus({ root });
        if (status.state !== 'ready') return { exitCode: 3, output: `Error (not-ready): The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}.\n` };
        return command.command === 'list' ? list(root, command) : show(root, command);
    }
    const input: ActionInput = {
        root,
        eventId: command.eventId,
        expectedVersion: command.version,
        ...(command.base === undefined ? {} : { expectedBase: command.base }),
        actor: context.actor,
        ...(context.clock ? { clock: context.clock } : {}),
        ...(context.waitMs === undefined ? {} : { waitMs: context.waitMs }),
    };
    switch (command.command) {
        case 'edit':
            return report(await editEvent({ ...input, choices: command.choices }));
        case 'approve':
            return report(await approveEvent({ ...input, choices: command.choices }));
        case 'defer':
            // #17's leave in draft: #14's defer for every type, and for a confirmed replacement, the earlier revision put back.
            return report(await leaveInDraft({ ...input, reason: command.reason }));
        case 'dismiss':
            return report(await dismissEvent({ ...input, reason: command.reason }));
        case 'retry':
            return report(await retryEvent({ ...input, reason: command.reason }));
        case 'reopen':
            return report(await reopenEvent({ ...input, reason: command.reason }));
        case 'confirm':
            return report(await confirmReplacement(input));
        case 'bind':
            return report(await bindReplacement({ ...input, path: command.path, reason: command.reason }));
        case 'archive':
            return report(await archiveMissing({ ...input, reason: command.reason }));
    }
}

/** Run one parsed command. Never throws: every outcome is an exit code and text that names no absolute path. */
export async function runCurationCommand(context: CurationContext, command: CurationCommand): Promise<CommandResult> {
    let result: CommandResult;
    try {
        result = await run(context, command);
    } catch (error) {
        result = { exitCode: 4, output: `Error (storage): ${error instanceof Error ? error.message : String(error)}\n` };
    }
    return { ...result, output: printableLines(scrub(result.output, [context.dataRoot, context.libraryRoot])) };
}

/** Parse and run `curation <args>`, as scripts/photos.ts does. */
export async function runCurationCli(args: readonly string[], context: Omit<CurationContext, 'actor'> & { program?: string }, env: Readonly<Record<string, string | undefined>> = process.env): Promise<CommandResult> {
    let command: CurationCommand;
    let actor: string;
    try {
        command = parseCurationArgs(args);
        actor = actorFrom(args, env);
    } catch (error) {
        if (error instanceof CurationUsageError) return { exitCode: 2, output: scrub(`Usage error: ${error.message}\nUsage:\n${curationUsage(context.program)}\n`, [context.dataRoot, context.libraryRoot]) };
        throw error;
    }
    return runCurationCommand({ ...context, actor }, command);
}
