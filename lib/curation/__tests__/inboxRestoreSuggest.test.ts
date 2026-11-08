// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { folderBytes } from '../../../test/helpers/folderBytes';
import { identityPaths } from '../../identity/registry';
import { printable, runCurationCli } from '../commands';
import type { CurationEvent } from '../events';
import { loadInbox } from '../inbox';
import { runInboxAction } from '../inbox-form';
import { RESTORED_TEXT, restoreHint, resolvedResponse, suggestedFileLabel, type InboxView } from '../inbox-view';
import { listEvents } from '../repository';
import { archiveMissing } from '../resolutions';
import { createMissingWorld, removeMissingTemplate, type MissingWorld } from './missingWorld';
import { makeImages, P_PATH, type Images } from './replacementWorld';

/**
 * #17 on the Inbox, on the missing-source world (real images and passes): Restore, which takes Approve's place on a
 * new photograph whose bytes are an archived photograph's, and Bind's suggested files, which are `curation show`'s.
 * runInboxAction() is what the server actions call once requireCurator() lets them in. The worlds' temp roots stay
 * under the OS temp folder, and a file taken out of the library is moved, never deleted.
 */

let images: Images;
beforeAll(async () => {
    images = await makeImages();
}, 60_000);
afterAll(() => {
    removeMissingTemplate();
});

const ACTOR = 'curator:test';

const ready = (view: InboxView) => {
    if (view.state !== 'ready') throw new Error(`The inbox is ${view.state}`);
    return view;
};
const shown = async (id: string) => ready(await loadInbox(id)).selected!;

function itemForm(event: Pick<CurationEvent, 'id' | 'version'>, base: string | null, extra: Record<string, string> = {}): FormData {
    const form = new FormData();
    for (const [name, value] of Object.entries({ eventId: event.id, version: String(event.version), base: base ?? 'none', ...extra })) form.set(name, value);
    return form;
}

/** P's file out of the library, moved to a folder of its own, as the owner deleting it looks to the watcher. */
function takeP(w: MissingWorld): void {
    fs.renameSync(w.lib.file(P_PATH), path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-taken-')), 'landscape.jpg'));
}

/** #10's decisions waiting for the watcher's next pass. */
const pending = (root: string) => {
    const dir = identityPaths(root).decisions;
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))) : [];
};
const written = (root: string) => ({ authored: folderBytes(path.join(root, 'authored')), curation: folderBytes(path.join(root, 'curation')), decisions: pending(root) });

const newItemAt = async (w: MissingWorld, at: string) => (await listEvents(w.root)).events.find((entry) => entry.type === 'new' && entry.derivedFacts.sourcePath === at) as CurationEvent;

describe('Restore on the Inbox (#17)', { timeout: 60_000 }, () => {
    /** P archived, then its bytes back at another path, a new photograph the pass says is a copy of P. */
    async function archivedBack(): Promise<{ w: MissingWorld; item: CurationEvent }> {
        const w = await createMissingWorld(images);
        takeP(w);
        await w.pass();
        const missing = await w.event(w.missingId);
        expect(await archiveMissing({ root: w.root, eventId: missing.id, expectedVersion: missing.version, expectedBase: w.revisionId, actor: ACTOR })).toMatchObject({ ok: true });
        await w.pass();
        fs.mkdirSync(w.lib.file('returned'));
        fs.writeFileSync(w.lib.file('returned/landscape.jpg'), images.original);
        const facts = await w.pass();
        expect(facts.find((entry) => entry.type === 'new')).toMatchObject({ duplicateOf: w.p });
        return { w, item: await newItemAt(w, 'returned/landscape.jpg') };
    }

    it('names the archived photograph a new one restores, and restores it with no series, position or description, answering as a restored item says', async () => {
        const { w, item } = await archivedBack();
        const detail = await shown(item.id);
        expect(detail).toMatchObject({ type: 'new', restores: { name: 'landscape.jpg' } });
        expect(detail.can.approve).toBe(true);
        expect(restoreHint(detail.restores!.name)).toBe(
            'This file matches landscape.jpg, an archived photograph. Restore brings it back with its original details, outside any series. Add it to a series from the Series screen afterwards.',
        );
        // The page sends no series or description with Restore, and the server takes none it's sent.
        const state = await runInboxAction('restore', itemForm(item, w.revisionId, { series: 'ser_harbor', description: 'Not used.' }));
        expect(state).toMatchObject({ status: 'done', action: 'restore', eventId: item.id, message: RESTORED_TEXT });
        expect(RESTORED_TEXT).toBe(resolvedResponse({ kind: 'restored' }, 'new'));
        expect(pending(w.root)).toEqual([expect.objectContaining({ type: 'restore', path: 'returned/landscape.jpg', photoId: w.p, merge: item.photoId })]);
        expect((await w.event(item.id)).decisions.at(-1)).toMatchObject({ action: 'approve', restores: w.p });
        // Approved, so the page offers it no more.
        expect((await shown(item.id)).restores).toBeNull();
    });

    it('offers no Restore on a new photograph that is no archived one\'s, and refuses a Restore sent for it as stale, writing nothing', async () => {
        const w = await createMissingWorld(images);
        fs.writeFileSync(w.lib.file('harbor/other.jpg'), images.third);
        await w.pass();
        const item = await newItemAt(w, 'harbor/other.jpg');
        expect((await shown(item.id)).restores).toBeNull();
        const before = written(w.root);
        const state = await runInboxAction('restore', itemForm(item, w.revisionId));
        expect(state).toMatchObject({ status: 'stale', action: 'restore', message: 'This item changed since the page loaded, so nothing was written. Refresh and review it again.' });
        expect(written(w.root)).toEqual(before);
        expect(await w.event(item.id)).toMatchObject({ status: 'open', version: item.version });
    });
});

describe("Bind's suggested files on the Inbox (#17)", { timeout: 60_000 }, () => {
    /** P's file gone, then other pixels with its file name at `at`, which the watcher suggests for P. */
    async function suggested(at: string): Promise<{ w: MissingWorld; missing: CurationEvent; item: CurationEvent }> {
        const w = await createMissingWorld(images);
        takeP(w);
        await w.pass();
        fs.mkdirSync(path.dirname(w.lib.file(at)), { recursive: true });
        fs.writeFileSync(w.lib.file(at), images.replacement);
        const [added] = await w.pass();
        expect(added).toMatchObject({ type: 'new', suggestedFor: w.p, suggestedBy: 'basename' });
        return { w, missing: await w.event(w.missingId), item: await newItemAt(w, at) };
    }

    it("lists the files `curation show` suggests, after the linked ones, and binds the one chosen by its path, as `curation bind --path` does", async () => {
        const { w, missing, item } = await suggested('edits/landscape.jpg');
        const detail = await shown(w.missingId);
        expect(detail.linkedFiles).toEqual([]);
        expect(detail.suggestedFiles).toEqual([{ id: item.id, path: 'edits/landscape.jpg', libraryPath: 'edits/landscape.jpg', by: 'basename' }]);
        expect(suggestedFileLabel('edits/landscape.jpg', 'basename')).toBe('edits/landscape.jpg: same file name, different pixels');
        expect(suggestedFileLabel('edits/landscape.jpg', 'capture-time')).toBe('edits/landscape.jpg: taken at the same moment, different pixels');
        const show = (await runCurationCli(['show', w.missingId], { dataRoot: w.root, libraryRoot: w.lib.root }, {})).output;
        expect(show).toContain('Suggested: edits/landscape.jpg has its file name');
        const state = await runInboxAction('bind', itemForm(missing, w.revisionId, { bindTo: 'typed', path: 'edits/landscape.jpg' }));
        expect(state).toMatchObject({ status: 'done', action: 'bind' });
        expect(pending(w.root)).toEqual([expect.objectContaining({ type: 'bind', path: 'edits/landscape.jpg', photoId: w.p, merge: item.photoId })]);
    });

    it('sends the path itself for a name the page shows escaped, so a backslash in it binds that file', async () => {
        const at = 'ed\\its/landscape.jpg';
        const { w, missing, item } = await suggested(at);
        const [file] = (await shown(w.missingId)).suggestedFiles;
        expect(file).toEqual({ id: item.id, path: printable(at), libraryPath: at, by: 'basename' });
        expect(file.path).not.toBe(at);
        expect(await runInboxAction('bind', itemForm(missing, w.revisionId, { bindTo: 'typed', path: file.libraryPath }))).toMatchObject({ status: 'done' });
        expect(pending(w.root)).toEqual([expect.objectContaining({ type: 'bind', path: at, photoId: w.p })]);
    });
});
