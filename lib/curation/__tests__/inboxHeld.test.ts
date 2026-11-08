// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setDataDir } from '../../../test/helpers/tempDataRoot';
import { readRegistry, writeRegistry } from '../../identity/registry';
import type { IdentityFact, PhotoRecord } from '../../identity/types';
import { eventIdOf, eventKey, type CurationEvent } from '../events';
import { loadInbox, loadInboxSummary } from '../inbox';
import { runInboxAction } from '../inbox-form';
import { listPage, parseInboxQuery, STATUS_FILTERS } from '../inbox-list';
import { RELEASE_HINT, RELEASED_ANSWER, summaryText, type InboxView } from '../inbox-view';
import { heldMissingIds, LIBRARY_EVENT_ID, readLibraryItem } from '../library';
import { listEvents, readEvent } from '../repository';
import { createCurationSink } from '../sink';
import { createCurationFixture, type CurationFixture } from './curationFixtures';

/**
 * #17: the Inbox's held items, while the library item is open. Held is no stored status: it's the missing items
 * heldMissingIds() returns. The page counts them apart from the items that need judgment, lists them under the Status
 * filter's Held, offers Release on each, which is `curation confirm-missing`, and says so in its banner. The summary
 * the poll reads leaves them out of its judgment count too, and carries no held count.
 *
 * The temp roots stay under the OS temp folder.
 */

const restores: (() => void)[] = [];
afterEach(() => {
    for (const restore of restores.splice(0).reverse()) restore();
});

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
const OUTAGE = '2026-02-01T02:00:00.000Z';
const hex = (n: number) => n.toString(16).padStart(64, '0');

async function served(): Promise<CurationFixture> {
    const f = await createCurationFixture({ published: true });
    restores.push(setDataDir(f.root));
    return f;
}

/** Add `count` present photos to the registry, as if the library held that many more. */
async function addPhotos(f: CurationFixture, count: number): Promise<PhotoRecord[]> {
    const registry = await readRegistry(f.root);
    const template = registry.photos[f.fresh[0]];
    const added: PhotoRecord[] = [];
    for (let index = 0; index < count; index++) {
        const photoId = `ph_00000000-0000-4000-8000-${String(7000 + index).padStart(12, '0')}`;
        const assetRevision = `sha256-${hex(0xa0000 + index)}`;
        const sourcePath = `bulk/photo-${index}.jpg`;
        const revision = { ...template.revisions[template.source.observedRevision], assetRevision, firstSeenPath: sourcePath };
        const record: PhotoRecord = { ...template, photoId, source: { ...template.source, path: sourcePath, key: sourcePath, observedRevision: assetRevision }, revisions: { [assetRevision]: revision } };
        registry.photos[photoId] = record;
        added.push(record);
    }
    await writeRegistry(f.root, registry, registry.version);
    return added;
}

/** Mark `photos` missing, then deliver one pass's missing facts for them. 20 of 36 bound opens the library item, holding them. */
async function goMissing(f: CurationFixture, photos: readonly PhotoRecord[], observedAt = OUTAGE): Promise<string[]> {
    const registry = await readRegistry(f.root);
    for (const photo of photos) {
        registry.photos[photo.photoId].source.present = false;
        registry.photos[photo.photoId].sourceHealth = 'missing';
    }
    await writeRegistry(f.root, registry, registry.version);
    const facts: IdentityFact[] = photos.map((photo) => f.fact('missing', photo.photoId, { assetRevision: photo.source.observedRevision, path: photo.source.path, observedAt }));
    await createCurationSink({ root: f.root, logger: quiet })(facts);
    return facts.map((fact) => eventIdOf(eventKey('missing', fact)));
}

/** The fixture's two new photographs, open, then one missing item from before the outage, then 20 held. */
async function heldWorld() {
    const f = await served();
    await createCurationSink({ root: f.root, logger: quiet })(f.fresh.map((photoId) => f.fact('new', photoId)));
    const added = await addPhotos(f, 30);
    const [earlier] = await goMissing(f, added.slice(0, 1), '2026-02-01T01:00:00.000Z');
    const held = await goMissing(f, added.slice(1, 21));
    expect(await readLibraryItem(f.root)).toMatchObject({ status: 'open', derivedFacts: { library: { cause: 'mass-missing' } } });
    return { f, earlier, held };
}

const ready = (view: InboxView) => {
    if (view.state !== 'ready') throw new Error(`The inbox is ${view.state}`);
    return view;
};

function itemForm(event: Pick<CurationEvent, 'id' | 'version'>, base: string | null, extra: Record<string, string> = {}): FormData {
    const form = new FormData();
    for (const [name, value] of Object.entries({ eventId: event.id, version: String(event.version), base: base ?? 'none', ...extra })) form.set(name, value);
    return form;
}

describe('held items on the Inbox (#17)', { timeout: 60_000 }, () => {
    it('marks exactly what heldMissingIds() returns as held, and leaves those out of the judgment count', async () => {
        const { f, earlier, held } = await heldWorld();
        const { events } = await listEvents(f.root);
        expect(new Set(heldMissingIds(events, await readLibraryItem(f.root)))).toEqual(new Set(held));
        const view = ready(await loadInbox(null));
        expect(new Set(view.items.filter((item) => item.held).map((item) => item.id))).toEqual(new Set(held));
        expect(view.items.find((item) => item.id === earlier)).toMatchObject({ held: false, group: 'judgment' });
        // The two new photographs, the missing item from before the outage, and the library item itself.
        expect(view.needsJudgment).toBe(4);
        expect(view.held).toBe(20);
        expect(summaryText({ needsJudgment: 5, held: 3, waiting: 0 })).toBe('5 items require judgment, 3 held');
        expect(summaryText(view)).toMatch(/^4 of \d+ items require judgment, 20 held/);
    });

    it('lists the held items under the Status filter\'s Held, which the URL takes as ?status=held', async () => {
        const { held } = await heldWorld();
        expect(STATUS_FILTERS.at(-1)).toEqual({ value: 'held', label: 'Held' });
        const query = parseInboxQuery({ status: 'held' });
        expect(query).toEqual({ status: 'held', type: null, page: 1 });
        const view = ready(await loadInbox(null, { query }));
        expect(new Set(listPage(view.items, query).items.map((item) => item.id))).toEqual(new Set(held));
        // With no item in the URL, the first held item opens, with Release on it.
        expect(held).toContain(view.selected?.id);
        expect(view.selected).toMatchObject({ held: true, release: true });
    });

    it('leaves held items out of the summary\'s judgment count and arrivals, and carries no held count in it', async () => {
        const { f } = await heldWorld();
        const summary = await loadInboxSummary(null, { since: 0 });
        expect(summary).toMatchObject({ state: 'ready', needsJudgment: 4, arrived: 4 });
        expect(summary).not.toHaveProperty('held');
        expect(summary).not.toHaveProperty('library');
        expect(JSON.stringify(summary)).not.toContain('mass-missing');
        void f;
    });

    it('gives the banner the cause in words, the held count and the library item, and nothing while the library is available', async () => {
        const { f } = await heldWorld();
        const view = ready(await loadInbox(null));
        expect(view.library).toEqual({ cause: 'one pass found 20 of 35 bound sources missing', held: 20, itemId: LIBRARY_EVENT_ID });
        void f;
        await served();
        expect(ready(await loadInbox(null)).library).toBeNull();
    });

    it('releases one held item with Release, as confirm-missing, with an optional reason, and it counts as missing then', async () => {
        const { f, held } = await heldWorld();
        const [first, second] = held;
        const event = (await readEvent(f.root, first)) as CurationEvent;
        const base = ready(await loadInbox(first)).activeRevisionId;
        const state = await runInboxAction('release', itemForm(event, base, { reason: 'Deleted on purpose.' }));
        expect(state).toMatchObject({ status: 'done', action: 'release', eventId: first, message: RELEASED_ANSWER });
        expect((await readEvent(f.root, first))?.decisions.at(-1)).toMatchObject({ action: 'confirm-missing', reason: 'Deleted on purpose.', by: 'curator:web' });
        const after = ready(await loadInbox(first));
        expect(after.selected).toMatchObject({ id: first, held: false, release: false });
        expect(after.held).toBe(19);
        expect(after.needsJudgment).toBe(5);
        // With no reason, as the CLI's confirm-missing takes none.
        const other = (await readEvent(f.root, second)) as CurationEvent;
        expect(await runInboxAction('release', itemForm(other, base))).toMatchObject({ status: 'done', message: RELEASED_ANSWER });
        expect((await readEvent(f.root, second))?.decisions.at(-1)).toMatchObject({ action: 'confirm-missing' });
        expect((await readEvent(f.root, second))?.decisions.at(-1)).not.toHaveProperty('reason');
        expect(RELEASE_HINT).toBe("This item is on hold because the library can't be reached. Release it only if its file is really gone: it then counts as missing, and Bind or Archive settles it.");
    });

    it('offers Release on no item that isn\'t held', async () => {
        const { earlier } = await heldWorld();
        expect(ready(await loadInbox(earlier)).selected).toMatchObject({ held: false, release: false });
        expect(ready(await loadInbox(LIBRARY_EVENT_ID)).selected).toMatchObject({ held: false, release: false });
    });
});

describe('the Bind suggestions\' one source (#17)', () => {
    // `curation show` and the Inbox list the same suggested files because both call bindSuggestions(), never their own copy.
    const source = (file: string) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

    it('is bindSuggestions(), which `curation show` and the Inbox both call, and neither reads suggestedNewItems() itself', () => {
        for (const file of ['commands.ts', 'inbox.ts']) {
            expect(source(file), file).toMatch(/\bbindSuggestions\(root, event\.photoId, registry\)/);
            expect(source(file), file).not.toMatch(/\bsuggestedNewItems\b/);
        }
    });
});
