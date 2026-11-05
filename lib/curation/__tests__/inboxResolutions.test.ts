// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary } from '../../../test/helpers/tempLibrary';
import { fixtureFiles } from '../../../test/fixtures/makeLibrary';
import { writeAuthoredRecord } from '../../catalog/working-layer-writer';
import { readAuthoredRecord } from '../../catalog/working-layer';
import { runReconcilePass } from '../../identity/pass';
import { identityPaths, readRegistry, writeRegistry } from '../../identity/registry';
import { approveEvent } from '../actions';
import { createCandidateSink } from '../candidates';
import { CURATION_COMMANDS, curationUsage, parseCurationArgs, runCurationCli } from '../commands';
import {
    ACTIONS,
    CLOSE_REASONS,
    closeCauseOf,
    CURATION_SCHEMA_VERSION,
    eventIdOf,
    eventKey,
    parseEvent,
    schemaVersionFor,
    type CurationEvent,
} from '../events';
import { resolvedResponse } from '../inbox-view';
import { curationPaths, listEvents, readEvent, withCurationLock, writeEvent } from '../repository';
import { archiveMissing, bindReplacement } from '../resolutions';
import { createCurationSink } from '../sink';
import { createCurationFixture, type CurationFixture } from './curationFixtures';
import { clock, createMissingWorld, removeMissingTemplate, type MissingWorld } from './missingWorld';
import { createWorld, makeImages, P_PATH, quiet, removeTemplate, replacementEventId, treeBytes, type Images, type World } from './replacementWorld';

/**
 * A5 (#14 and #17): the Inbox's resolutions and replacement facts, the
 * archived restore, `landscape-rot6.jpg` through the Inbox, and the curation
 * event schema's version 2, which v1.7.x reads as a newer build's.
 */

const ACTOR = 'curator:test';
const REPO = path.resolve(__dirname, '../../..');

/**
 * What v1.7.x's strict event schema accepts (lib/curation/events.ts at v1.7.0, 0de8ab31). A file stamped
 * schemaVersion 1 has to fit inside these, since v1.7.x reads it after an image rollback. Anything else has
 * to be stamped higher, so v1.7.x reports it as a newer build's instead of as damaged.
 */
const V1 = {
    event: ['schemaVersion', 'version', 'id', 'key', 'type', 'photoId', 'sourceFingerprint', 'assetRevision', 'observedAt', 'lastObservedAt', 'factIds', 'status', 'derivedFacts', 'suggestions', 'edits', 'candidate', 'decisions', 'reviewedAt', 'reviewedBy'],
    decision: ['action', 'at', 'by', 'baseRevisionId', 'reason', 'seriesId', 'placement', 'writes', 'identityDecisionId', 'fromRevision', 'path'],
    derivedFacts: ['factType', 'sourcePath', 'folder', 'fromPath', 'candidates', 'duplicateOf', 'samePathAs', 'revert', 'failure', 'capturedDate', 'width', 'height', 'sourceFormat'],
    actions: ['edit', 'approve', 'defer', 'dismiss', 'retry', 'reopen', 'confirm', 'bind', 'archive', 'close'],
    types: ['new', 'replacement', 'missing', 'reappeared', 'ambiguous', 'processing-failure'],
};

/** Whether v1.7.x's schema could read `event` as it is. */
function v1Reads(event: CurationEvent): boolean {
    const keysIn = (value: object, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));
    return keysIn(event, V1.event) && V1.types.includes(event.type) && keysIn(event.derivedFacts, V1.derivedFacts)
        && event.decisions.every((decision) => keysIn(decision, V1.decision) && V1.actions.includes(decision.action));
}

/** v1.7.x's parseEvent() gate: a newer schemaVersion reads as `unknown-schema-version`, before the schema runs. */
const v1Gate = (value: { schemaVersion: number }) => (value.schemaVersion > 1 ? 'unknown-schema-version' : 'schema');

let fixture: CurationFixture | null = null;
afterEach(async () => {
    await fixture?.cleanup();
    fixture = null;
});

async function freshItem(): Promise<{ f: CurationFixture; event: CurationEvent }> {
    fixture = await createCurationFixture();
    const f = fixture;
    await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.fresh[0])]);
    const { events } = await listEvents(f.root);
    return { f, event: events[0] };
}

describe('the curation event schema', () => {
    it('is version 2, and still reads version 1 files', async () => {
        expect(CURATION_SCHEMA_VERSION).toBe(2);
        const { event } = await freshItem();
        expect(parseEvent({ ...event, schemaVersion: 1 })).toMatchObject({ ok: true });
        expect(parseEvent({ ...event, schemaVersion: 2 })).toMatchObject({ ok: true });
        expect(parseEvent({ ...event, schemaVersion: 3 })).toMatchObject({ ok: false, reason: 'unknown-schema-version' });
    });

    it('stamps version 1 on what v1.7.x reads, and version 2 on anything only v2 reads', async () => {
        const { event } = await freshItem();
        const close = { action: 'close' as const, at: event.observedAt, by: 'watcher', baseRevisionId: null };
        const samples: CurationEvent[] = [
            event,
            { ...event, status: 'resolved', decisions: [{ ...close, reason: CLOSE_REASONS.moved }] },
            { ...event, status: 'resolved', decisions: [{ ...close, reason: CLOSE_REASONS.withdrawn, resolution: 'withdrawn' }] },
            { ...event, decisions: [{ ...close, action: 'resolve', resolveAs: 'new', identityDecisionId: '00000000-0000-4000-8000-000000000001' }] },
            { ...event, decisions: [{ ...close, action: 'confirm-missing' }] },
            { ...event, decisions: [{ ...close, action: 'approve', restores: event.photoId as string }] },
            { ...event, derivedFacts: { ...event.derivedFacts, suggestedFor: event.photoId as string, suggestedBy: 'basename' } },
        ];
        for (const sample of samples) {
            const stamped = schemaVersionFor(sample);
            expect(stamped === 1, JSON.stringify(sample.decisions)).toBe(v1Reads(sample));
        }
        expect(ACTIONS).toEqual(expect.arrayContaining([...V1.actions, 'resolve', 'confirm-missing']));
    });

    it('writes each version file stamped for the oldest build that reads it, so a v1.7.x rollback reads the rest as newer, not damaged', async () => {
        const { f, event } = await freshItem();
        const folder = path.join(curationPaths(f.root).events, event.id);
        const stamp = (n: number) => (JSON.parse(fs.readFileSync(path.join(folder, `v${n}.json`), 'utf8')) as { schemaVersion: number }).schemaVersion;
        expect(stamp(1)).toBe(1);
        await withCurationLock(f.root, {}, async (hold) => {
            await writeEvent(f.root, { ...event, schemaVersion: 2, decisions: [{ action: 'confirm-missing', at: event.observedAt, by: ACTOR, baseRevisionId: null }] }, 1, hold);
        });
        expect(stamp(2)).toBe(2);
        expect(v1Gate({ schemaVersion: stamp(2) })).toBe('unknown-schema-version');
        expect(await readEvent(f.root, event.id)).toMatchObject({ schemaVersion: 2, version: 2, decisions: [{ action: 'confirm-missing' }] });
    });
});

describe('the curation commands', () => {
    const ID = 'evt_0123456789abcdef01234567';
    const PHOTO = 'ph_00000000-0000-4000-8000-0000000000bb';

    it('parse resolve, bind --to, and confirm-missing', () => {
        expect(parseCurationArgs(['resolve', ID, '--version', '2', '--as', 'new'])).toEqual({ command: 'resolve', eventId: ID, version: 2, as: 'new' });
        expect(parseCurationArgs(['resolve', ID, '--version', '2', '--as', 'replacement-of', PHOTO, '--base', 'none'])).toEqual({ command: 'resolve', eventId: ID, version: 2, base: null, as: 'replacement-of', photoId: PHOTO });
        expect(parseCurationArgs(['bind', ID, '--version', '3', '--to', PHOTO])).toEqual({ command: 'bind', eventId: ID, version: 3, to: PHOTO });
        expect(parseCurationArgs(['confirm-missing', ID, '--version', '1'])).toEqual({ command: 'confirm-missing', eventId: ID, version: 1 });
        for (const bad of [
            ['resolve', ID, '--version', '2'],
            ['resolve', ID, '--version', '2', '--as', 'other'],
            ['resolve', ID, '--version', '2', '--as', 'replacement-of'],
            ['resolve', ID, '--version', '2', '--as', 'new', PHOTO],
            ['bind', ID, '--version', '2', '--to', 'nope'],
            ['bind', ID, '--version', '2', '--to', PHOTO, '--path', 'a.jpg'],
        ]) {
            expect(() => parseCurationArgs(bad), bad.join(' ')).toThrow();
        }
    });

    it('are all in the usage text and in README.md\'s curation line', () => {
        const usage = curationUsage('photos');
        expect(usage).toContain('curation resolve <eventId> --version <n> --as new | --as replacement-of <photoId>');
        expect(usage).toContain('curation bind <eventId> --version <n> [--path <library path> | --to <photoId>]');
        expect(usage).toContain('curation confirm-missing <eventId> --version <n>');
        const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
        const line = readme.split('\n').find((entry) => entry.startsWith('- `curation '));
        expect(line).toBeDefined();
        const listed = /^- `curation ([^`]+)`/.exec(line as string)?.[1].split(' | ') ?? [];
        expect(listed).toEqual([...CURATION_COMMANDS]);
        expect(listed).toEqual(expect.arrayContaining(['confirm', 'bind', 'archive']));
    });
});

describe('an ambiguous item', () => {
    const HELD = 'trips/held.jpg';

    /** The fixture's two fresh photographs, sourceless, and a file #10 holds in doubt between them: row 9. */
    async function heldItem(): Promise<{ f: CurationFixture; event: CurationEvent; x: string; y: string }> {
        fixture = await createCurationFixture();
        const f = fixture;
        const [x, y] = f.fresh;
        const registry = await readRegistry(f.root);
        const bytes = f.revisionOf(x);
        for (const id of [x, y]) {
            registry.photos[id].source.present = false;
            registry.photos[id].sourceHealth = 'ambiguous';
        }
        registry.photos[y].revisions[bytes] = { ...registry.photos[x].revisions[bytes] };
        registry.holds = [{ path: HELD, assetRevision: bytes, candidates: [x, y], since: '2026-02-01T00:00:00.000Z' }];
        await writeRegistry(f.root, registry, registry.version);
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('ambiguous', null, { assetRevision: bytes, path: HELD, candidates: [x, y] })]);
        const event = (await listEvents(f.root)).events.find((item) => item.type === 'ambiguous') as CurationEvent;
        return { f, event, x, y };
    }

    const cli = (f: CurationFixture, args: string[]) => runCurationCli(args, { dataRoot: f.root }, { PHOTOS_ACTOR: ACTOR });
    const pending = (f: CurationFixture) => {
        const dir = identityPaths(f.root).decisions;
        return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))) : [];
    };

    it('resolve --as new writes #10\'s new decision for the held file, and show says it is requested', async () => {
        const { f, event } = await heldItem();
        const run = await cli(f, ['resolve', event.id, '--version', String(event.version), '--as', 'new']);
        expect(run).toMatchObject({ exitCode: 0 });
        expect(pending(f)).toEqual([expect.objectContaining({ type: 'new', path: HELD })]);
        const after = (await readEvent(f.root, event.id)) as CurationEvent;
        expect(after).toMatchObject({ status: 'open', version: event.version + 1 });
        const resolve = after.decisions.at(-1);
        expect(resolve).toMatchObject({ action: 'resolve', resolveAs: 'new', by: ACTOR, path: HELD, identityDecisionId: pending(f)[0].decisionId });
        const shown = (await cli(f, ['show', event.id])).output;
        expect(shown).toContain(`Resolve pending: the watcher applies the decision ${pending(f)[0].decisionId} for ${HELD} on its next pass`);
        expect(shown).toContain(`Requested at ${resolve?.at}`);
        // One decision at a time.
        expect(await cli(f, ['resolve', event.id, '--version', String(after.version), '--as', 'new'])).toMatchObject({ exitCode: 1 });
        expect(pending(f)).toHaveLength(1);
    });

    it('bind --to gives the held file to one of the photographs it may be', async () => {
        const { f, event, x } = await heldItem();
        expect(await cli(f, ['bind', event.id, '--version', String(event.version), '--to', x])).toMatchObject({ exitCode: 0 });
        expect(pending(f)).toEqual([expect.objectContaining({ type: 'bind', path: HELD, photoId: x })]);
        expect((await readEvent(f.root, event.id))?.decisions.at(-1)).toMatchObject({ action: 'bind', to: x, path: HELD });
    });

    it('bind --to refuses a photograph the hold doesn\'t name, and points at resolve --as replacement-of', async () => {
        const { f, event } = await heldItem();
        const other = f.catalog.photos[0].id;
        const run = await cli(f, ['bind', event.id, '--version', String(event.version), '--to', other]);
        expect(run).toMatchObject({ exitCode: 1 });
        expect(run.output).toContain(`curation resolve ${event.id} --version ${event.version} --as replacement-of ${other}`);
        expect(pending(f)).toEqual([]);
    });

    it('resolve --as replacement-of binds the held file to a photograph whose file is gone, and refuses one present elsewhere', async () => {
        const { f, event } = await heldItem();
        const [present, gone] = f.catalog.photos.map((photo) => photo.id);
        const registry = await readRegistry(f.root);
        registry.photos[gone].source.present = false;
        registry.photos[gone].sourceHealth = 'missing';
        await writeRegistry(f.root, registry, registry.version);
        const refused = await cli(f, ['resolve', event.id, '--version', String(event.version), '--as', 'replacement-of', present]);
        expect(refused).toMatchObject({ exitCode: 1 });
        expect(refused.output).toContain(`${present} is present at`);
        expect(await cli(f, ['resolve', event.id, '--version', String(event.version), '--as', 'replacement-of', gone])).toMatchObject({ exitCode: 0 });
        expect(pending(f)).toEqual([expect.objectContaining({ type: 'bind', path: HELD, photoId: gone })]);
        expect((await readEvent(f.root, event.id))?.decisions.at(-1)).toMatchObject({ action: 'resolve', resolveAs: 'replacement-of', to: gone });
    });

    it('refuse resolve on a new item, and approve names the ambiguous item\'s own commands', async () => {
        const { f, event } = await heldItem();
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.catalog.photos[0].id)]);
        const item = (await listEvents(f.root)).events.find((entry) => entry.type === 'new') as CurationEvent;
        expect(await cli(f, ['resolve', item.id, '--version', String(item.version), '--as', 'new'])).toMatchObject({ exitCode: 1 });
        const approved = await approveEvent({ root: f.root, eventId: event.id, expectedVersion: event.version, actor: ACTOR, choices: {} });
        expect(approved).toMatchObject({ ok: false, code: 'refused', message: expect.stringContaining('curation resolve or curation bind --to') });
    });
});

describe('the watcher\'s new closes', () => {
    it('word each for the Inbox, and read back as their cause', () => {
        expect(closeCauseOf(CLOSE_REASONS.reverted)).toBe('reverted');
        expect(closeCauseOf(CLOSE_REASONS.withdrawn)).toBe('withdrawn');
        expect(closeCauseOf(CLOSE_REASONS.split('ph_00000000-0000-4000-8000-0000000000bb'))).toBe('split');
        expect(closeCauseOf(CLOSE_REASONS.restored('ph_00000000-0000-4000-8000-0000000000bb'))).toBe('restored');
        for (const kind of ['reverted', 'withdrawn', 'split', 'restored'] as const) {
            expect(resolvedResponse({ kind }, 'replacement')).not.toBe(resolvedResponse(null, 'replacement'));
            expect(resolvedResponse({ kind }, 'missing')).not.toMatch(/\b(ph|evt|rev|p)_|sha256-/);
        }
    });
});

let images: Images;
const replacementWorlds: World[] = [];
const missingWorlds: MissingWorld[] = [];

beforeAll(async () => {
    images = await makeImages();
}, 60_000);

afterEach(async () => {
    for (const w of replacementWorlds.splice(0)) await w.cleanup();
    for (const w of missingWorlds.splice(0)) await w.cleanup();
});

afterAll(() => {
    removeTemplate();
    removeMissingTemplate();
});

async function replacementWorld(): Promise<World> {
    const w = await createWorld(images);
    replacementWorlds.push(w);
    return w;
}

async function missingWorld(): Promise<MissingWorld> {
    const w = await createMissingWorld(images);
    missingWorlds.push(w);
    return w;
}

const lastClose = (event: CurationEvent) => event.decisions.findLast((decision) => decision.action === 'close');
const openReplacements = async (root: string) => (await listEvents(root)).events.filter((item) => item.type === 'replacement' && (item.status === 'open' || item.status === 'failed')).map((item) => item.id);
const layers = (root: string) => ({
    assets: treeBytes(path.join(root, 'assets')),
    catalog: treeBytes(path.join(root, 'catalog')),
    authored: treeBytes(path.join(root, 'authored')),
    identity: treeBytes(identityPaths(root).dir),
});
const pendingIn = (root: string) => {
    const dir = identityPaths(root).decisions;
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))) : [];
};

describe('a replacement the source reverts', { timeout: 60_000 }, () => {
    it('closes as reverted when the source goes back to the bytes the photo record pins, and so does the revert\'s own item', async () => {
        const w = await replacementWorld();
        fs.writeFileSync(w.lib.file(P_PATH), images.original);
        await w.pass();
        const b = await w.event();
        expect(b).toMatchObject({ status: 'resolved' });
        expect(lastClose(b)).toMatchObject({ by: 'watcher', resolution: 'reverted', reason: CLOSE_REASONS.reverted });
        const a = await w.event(replacementEventId(w.p, w.a));
        expect(a).toMatchObject({ status: 'resolved', derivedFacts: { revert: true } });
        expect(lastClose(a)).toMatchObject({ by: 'watcher', resolution: 'reverted', reason: CLOSE_REASONS.reverted });
        expect(await openReplacements(w.root)).toEqual([]);
        // Its bytes back again: the newer item opens again, as a moved one does.
        fs.writeFileSync(w.lib.file(P_PATH), images.replacement);
        await w.pass();
        expect(await w.event()).toMatchObject({ status: 'open' });
    });

    it('closes the newest as reverted, not moved, when the source goes back past it', async () => {
        const w = await replacementWorld();
        fs.writeFileSync(w.lib.file(P_PATH), images.third);
        const c = (await w.pass()).find((fact) => fact.type === 'replaced')?.assetRevision as string;
        expect(lastClose(await w.event())).toMatchObject({ reason: CLOSE_REASONS.moved });
        fs.writeFileSync(w.lib.file(P_PATH), images.original);
        await w.pass();
        expect(lastClose(await w.event(replacementEventId(w.p, c)))).toMatchObject({ resolution: 'reverted' });
        expect(await openReplacements(w.root)).toEqual([]);
    });
});

describe('resolve --as new on a replacement', { timeout: 60_000 }, () => {
    it('gives the file its own photograph, and the item closes as split once the watcher applies it', async () => {
        const w = await replacementWorld();
        const item = await w.event();
        const before = { authored: treeBytes(path.join(w.root, 'authored')), catalog: treeBytes(path.join(w.root, 'catalog')) };
        const cli = (args: string[]) => runCurationCli(args, { dataRoot: w.root, libraryRoot: w.lib.root }, { PHOTOS_ACTOR: ACTOR });
        const run = await cli(['resolve', item.id, '--version', String(item.version), '--as', 'new', '--base', w.revisionId]);
        expect(run).toMatchObject({ exitCode: 0 });
        expect(pendingIn(w.root)).toEqual([expect.objectContaining({ type: 'new', path: P_PATH })]);
        expect(await w.event()).toMatchObject({ status: 'open' });

        const facts = await w.pass();
        const split = facts.find((fact) => fact.type === 'new');
        expect(split).toMatchObject({ path: P_PATH, assetRevision: w.b });
        const n = split?.photoId as string;
        const closed = await w.event();
        expect(closed).toMatchObject({ status: 'resolved' });
        expect(lastClose(closed)).toMatchObject({ by: 'watcher', resolution: 'split', reason: CLOSE_REASONS.split(n) });
        // The new photograph waits in its own item, and the draft and the live site are as they were.
        expect(await readEvent(w.root, eventIdOf(eventKey('new', { photoId: n, assetRevision: w.b, key: `new:${n}:${w.b}` })))).toMatchObject({ status: 'open' });
        expect({ authored: treeBytes(path.join(w.root, 'authored')), catalog: treeBytes(path.join(w.root, 'catalog')) }).toEqual(before);
    });
});

describe('a missing photograph', { timeout: 60_000 }, () => {
    it('closes as withdrawn when no revision or series lists it, and stays open while one does', async () => {
        const w = await missingWorld();
        fs.writeFileSync(w.lib.file('harbor/fresh.jpg'), images.fresh);
        const [added] = await w.pass();
        const n = added.photoId as string;
        fs.rmSync(w.lib.file('harbor/fresh.jpg'));
        await w.pass();
        const withdrawn = await w.event(eventIdOf(eventKey('missing', { photoId: n, assetRevision: added.assetRevision, key: `missing:${n}:${added.assetRevision}` })));
        expect(withdrawn).toMatchObject({ status: 'resolved' });
        expect(lastClose(withdrawn)).toMatchObject({ by: 'watcher', resolution: 'withdrawn', reason: CLOSE_REASONS.withdrawn });

        fs.rmSync(w.lib.file(P_PATH));
        await w.pass();
        expect(await w.event(w.missingId)).toMatchObject({ status: 'open' });
        // A restarted watcher looks at every item, and reopens nothing.
        await w.restartPass();
        expect((await w.event(withdrawn.id)).version).toBe(withdrawn.version);
    });

    it('confirm-missing records the curator\'s word on the item only', async () => {
        const w = await missingWorld();
        fs.rmSync(w.lib.file(P_PATH));
        await w.pass();
        const item = await w.event(w.missingId);
        const before = layers(w.root);
        const library = treeBytes(w.lib.root);
        const cli = (args: string[]) => runCurationCli(args, { dataRoot: w.root, libraryRoot: w.lib.root }, { PHOTOS_ACTOR: ACTOR });
        expect(await cli(['confirm-missing', item.id, '--version', String(item.version)])).toMatchObject({ exitCode: 0 });
        const confirmed = await w.event(w.missingId);
        expect(confirmed).toMatchObject({ status: 'open', version: item.version + 1 });
        expect(confirmed.decisions.at(-1)).toMatchObject({ action: 'confirm-missing', by: ACTOR });
        expect(layers(w.root)).toEqual(before);
        expect(treeBytes(w.lib.root)).toEqual(library);
        expect((await cli(['show', item.id])).output).toContain(`Confirmed missing by ${ACTOR} at ${confirmed.decisions.at(-1)?.at}`);
        // Only a missing item takes it.
        const other = (await listEvents(w.root)).events.find((entry) => entry.type === 'new') as CurationEvent;
        expect(await cli(['confirm-missing', other.id, '--version', String(other.version)])).toMatchObject({ exitCode: 1 });
    });

    it('is suggested for other pixels with its file name at a new path, which bind then takes', async () => {
        const w = await missingWorld();
        fs.rmSync(w.lib.file(P_PATH));
        await w.pass();
        fs.mkdirSync(w.lib.file('edits'));
        fs.writeFileSync(w.lib.file('edits/landscape.jpg'), images.replacement);
        const [added] = await w.pass();
        expect(added).toMatchObject({ type: 'new', suggestedFor: w.p, suggestedBy: 'basename' });
        const item = (await listEvents(w.root)).events.find((entry) => entry.type === 'new' && entry.photoId === added.photoId) as CurationEvent;
        expect(item.derivedFacts).toMatchObject({ suggestedFor: w.p, suggestedBy: 'basename' });
        const shown = (await runCurationCli(['show', w.missingId], { dataRoot: w.root, libraryRoot: w.lib.root }, {})).output;
        expect(shown).toContain('Linked: edits/landscape.jpg');
        const missing = await w.event(w.missingId);
        const bound = await bindReplacement({ root: w.root, eventId: missing.id, expectedVersion: missing.version, expectedBase: w.revisionId, actor: ACTOR });
        expect(bound).toMatchObject({ ok: true });
        expect(pendingIn(w.root)).toEqual([expect.objectContaining({ type: 'bind', path: 'edits/landscape.jpg', photoId: w.p, merge: added.photoId })]);
    });

    it('comes back under its old ID once archived, when its duplicate\'s item is approved', async () => {
        const w = await missingWorld();
        fs.rmSync(w.lib.file(P_PATH));
        await w.pass();
        const missing = await w.event(w.missingId);
        expect(await archiveMissing({ root: w.root, eventId: missing.id, expectedVersion: missing.version, expectedBase: w.revisionId, actor: ACTOR })).toMatchObject({ ok: true });
        await w.pass();
        expect((await w.registry()).photos[w.p].sourceHealth).toBe('archived');
        const pNew = eventIdOf(eventKey('new', { photoId: w.p, assetRevision: w.a, key: `new:${w.p}:${w.a}` }));
        expect(await w.event(pNew)).toMatchObject({ status: 'resolved' });

        fs.mkdirSync(w.lib.file('returned'));
        fs.writeFileSync(w.lib.file('returned/landscape.jpg'), images.original);
        const [back] = await w.pass();
        expect(back).toMatchObject({ type: 'new', duplicateOf: w.p });
        const n = back.photoId as string;
        const item = (await listEvents(w.root)).events.find((entry) => entry.type === 'new' && entry.photoId === n) as CurationEvent;
        const authored = treeBytes(path.join(w.root, 'authored'));

        expect(await approveEvent({ root: w.root, eventId: item.id, expectedVersion: item.version, expectedBase: w.revisionId, actor: ACTOR, choices: { seriesId: 'ser_harbor' } }))
            .toMatchObject({ ok: false, code: 'needs-choice' });
        const approved = await approveEvent({ root: w.root, eventId: item.id, expectedVersion: item.version, expectedBase: w.revisionId, actor: ACTOR, choices: {} });
        expect(approved).toMatchObject({ ok: true, event: { status: 'approved' } });
        expect(approved.ok && approved.notes.join(' ')).toContain(`restores ${w.p}`);
        expect(pendingIn(w.root)).toEqual([expect.objectContaining({ type: 'restore', path: 'returned/landscape.jpg', photoId: w.p, merge: n })]);
        expect(approved.ok && approved.event.decisions.at(-1)).toMatchObject({ action: 'approve', restores: w.p });
        // The approval writes no photo record for the duplicate: the photograph keeps its own.
        expect(treeBytes(path.join(w.root, 'authored'))).toEqual(authored);

        await w.pass();
        const registry = await w.registry();
        expect(registry.photos[w.p]).toMatchObject({ sourceHealth: 'present', source: { path: 'returned/landscape.jpg', present: true } });
        expect(registry.photos[n].mergedInto).toBe(w.p);
        const restored = await w.event(item.id);
        expect(restored).toMatchObject({ status: 'resolved' });
        expect(lastClose(restored)).toMatchObject({ resolution: 'restored', reason: CLOSE_REASONS.restored(w.p) });
        // Its own new item opens again, so the Inbox can place it once more.
        const reopened = await w.event(pNew);
        expect(reopened).toMatchObject({ status: 'open' });
        expect(reopened.decisions.at(-1)).toMatchObject({ action: 'reopen', by: 'watcher' });
        expect(await readAuthoredRecord(w.root, 'photo', w.p)).toMatchObject({ assetRevision: w.a });
    });
});

describe('landscape-rot6.jpg through the Inbox', { timeout: 60_000 }, () => {
    it('opens a replacement item with the before and after facts, and notes the orientation flip and the aspect change', async () => {
        const lib = await createTempLibrary();
        const data = createTempDataRoot();
        try {
            const fixtures = await fixtureFiles({ extras: true });
            const landscape = fixtures.get('landscape.jpg') as Buffer;
            const rotated = fixtures.get('landscape-rot6.jpg') as Buffer;
            let n = 0;
            const sinks = [createCurationSink({ logger: quiet, clock }), createCandidateSink({ logger: quiet, clock })];
            const pass = async () => {
                const outcome = await runReconcilePass({ clock, idGen: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, logger: quiet, sinks, clearDelivered: true });
                if (outcome.status !== 'committed') throw new Error(JSON.stringify(outcome));
                return outcome.facts;
            };
            fs.writeFileSync(lib.file('landscape.jpg'), landscape);
            const [added] = await pass();
            const p = added.photoId as string;
            await writeAuthoredRecord({ kind: 'photo', id: p, assetRevision: added.assetRevision }, { expectedVersion: 0, root: data.root });

            fs.writeFileSync(lib.file('landscape.jpg'), rotated);
            const [replaced] = await pass();
            expect(replaced).toMatchObject({ type: 'replaced', photoId: p });
            const item = (await readEvent(data.root, replacementEventId(p, replaced.assetRevision))) as CurationEvent;
            expect(item.derivedFacts.comparison).toEqual({
                before: { assetRevision: added.assetRevision, width: 960, height: 640, aspectRatio: 1.5, orientation: 'landscape', capturedAt: null, bytes: landscape.length },
                after: { assetRevision: replaced.assetRevision, width: 640, height: 960, aspectRatio: 0.6667, orientation: 'portrait', capturedAt: null, bytes: rotated.length },
                notes: ['aspect-ratio', 'orientation'],
            });
            expect(item.schemaVersion).toBe(2);
            const shown = (await runCurationCli(['show', item.id], { dataRoot: data.root, libraryRoot: lib.root }, {})).output;
            expect(shown).toContain(`Before: 960x640, landscape, aspect 1.5, no capture date, ${landscape.length} bytes`);
            expect(shown).toContain(`After: 640x960, portrait, aspect 0.6667, no capture date, ${rotated.length} bytes`);
            expect(shown).toContain('Check it: the aspect ratio changes by more than 1%, and the orientation flips.');
        } finally {
            await data.cleanup();
            await lib.cleanup();
        }
    });
});
