// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { VARIANT_BYTES } from '@/lib/catalog/__tests__/catalogFixtures';
import { publish, validateWorkingLayer } from '@/lib/catalog/publish';
import { listActivations } from '@/lib/catalog/repository';
import { createTestCatalog } from '@/lib/catalog/testing';
import { readWorkingLayer } from '@/lib/catalog/working-layer';
import { writeAuthoredRecord } from '@/lib/catalog/working-layer-writer';
import { displayFacts, IDLE_STATE, type ScreenView } from '@/lib/curation/publish-facts';
import { setDataDir } from '@/test/helpers/tempDataRoot';

// The Publish screen's warnings on a real data root: the three warning rules at once, listed after Validate and on
// the next load, counted as `photos validate` and the activation count them, and never in the way of Publish. The
// catalog is left under os.tmpdir(): this test deletes nothing. Test values only.

vi.mock('@/lib/curation/auth', async (importOriginal) => ({ ...(await importOriginal<object>()), requireCurator: async () => ({}) }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
const quiet = { log: () => undefined };

const { loadPublishPage } = await import('../load');
const { publishAction } = await import('../actions');

async function view(): Promise<ScreenView> {
    const page = await loadPublishPage();
    if (page.state !== 'ready') throw new Error(`The page is ${page.state}`);
    return page.view;
}

function form(fields: Record<string, string>): FormData {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.set(name, value);
    return data;
}

describe('the Publish screen with warnings', () => {
    it("lists all three rules' warnings after Validate and on the next load, counts them as photos validate and the activation do, and publishes with them", { timeout: 120_000 }, async () => {
        const catalog = await createTestCatalog({ seed: 161, photos: 3, series: [{ title: 'Fixture harbor' }, { title: 'Fixture other' }], variantBytes: VARIANT_BYTES });
        const root = catalog.root;
        const restore = setDataDir(root);
        try {
            expect(await publish({ dataRoot: root, actor: 'test', confirmLaunch: true, logger: quiet })).toMatchObject({ outcome: 'PUBLISHED', warnings: 0 });
            // The draft: a description with camera details, one past 250 characters, and two series with one title.
            const layer = await readWorkingLayer(root);
            const [first, second] = layer.photos;
            await writeAuthoredRecord({ ...first, alt: { kind: 'described', text: 'A fixture street at dusk, shot at 35mm.', reviewed: true } }, { expectedVersion: first.version, root });
            await writeAuthoredRecord({ ...second, alt: { kind: 'described', text: `A fixture description ${'that runs on '.repeat(25)}`, reviewed: true } }, { expectedVersion: second.version, root });
            const series = layer.series[1];
            await writeAuthoredRecord({ ...series, title: 'FIXTURE HARBOR' }, { expectedVersion: series.version, root });

            const loaded = await view();
            expect(loaded.kind).toBe('ledger');
            // No check of this draft has run, so the page has none to list yet.
            expect(loaded.warnings ?? []).toEqual([]);

            const validated = await publishAction(IDLE_STATE, form({ intent: 'validate', draftId: loaded.draftId, active: loaded.active.revisionId }));
            const answer = validated.answer;
            if (answer?.kind !== 'valid') throw new Error(`Validate answered ${answer?.kind}`);
            const checked = await validateWorkingLayer({ dataRoot: root });
            // Three rules, four warnings: the shared title is one on each series.
            expect(checked).toMatchObject({ errors: 0, warnings: 4 });
            const found = checked.issues.filter((issue) => issue.severity === 'warning');
            expect([...new Set(found.map((issue) => issue.code))].sort()).toEqual(['description.camera-tokens', 'description.length', 'series.duplicate-title']);
            const words = found.map((issue) => issue.message);
            // One source of text: the rules' own messages, as `photos validate` prints them.
            expect(answer.warnings?.map((warning) => warning.message)).toEqual(words);
            expect(displayFacts(loaded, validated.result, null).bar).toMatchObject({ publish: 'available' });

            // The next load lists the same ones, from the check's diagnostics.
            const reloaded = await view();
            expect(reloaded.warnings?.map((warning) => warning.message)).toEqual(words);

            const published = await publishAction(validated, form({ intent: 'publish', draftId: loaded.draftId, active: loaded.active.revisionId, validated: loaded.draftId }));
            expect(published.answer).toMatchObject({ kind: 'published', live: { revisionId: loaded.draftId } });
            expect((await listActivations(root)).at(-1)).toMatchObject({ revisionId: loaded.draftId, validation: { errors: 0, warnings: 4 } });
        } finally {
            restore();
        }
    });
});
