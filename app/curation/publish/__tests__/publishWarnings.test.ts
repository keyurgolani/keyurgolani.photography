// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { VARIANT_BYTES } from '@/lib/catalog/__tests__/catalogFixtures';
import { publish, validateWorkingLayer, type PublishResult } from '@/lib/catalog/publish';
import { listActivations } from '@/lib/catalog/repository';
import { createTestCatalog } from '@/lib/catalog/testing';
import type { Issue } from '@/lib/catalog/types';
import { readWorkingLayer } from '@/lib/catalog/working-layer';
import { writeAuthoredRecord } from '@/lib/catalog/working-layer-writer';
import { displayFacts, IDLE_STATE, type ScreenView } from '@/lib/curation/publish-facts';
import { readRegistry, writeRegistry } from '@/lib/identity/registry';
import type { SourceHealth } from '@/lib/identity/types';
import { setDataDir } from '@/test/helpers/tempDataRoot';

// The Publish screen's warnings on a real data root: the three warning rules at once, listed after Validate and on
// every load, counted as `photos validate` and the activation count them, and never in the way of Publish. Each
// catalog is left under os.tmpdir(): this test deletes nothing. Test values only.

vi.mock('@/lib/curation/auth', async (importOriginal) => ({ ...(await importOriginal<object>()), requireCurator: async () => ({}) }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
// The next publish() the screen's action runs answers this instead, as one that found an error at the switch would.
const stand: { next: PublishResult | null } = { next: null };
vi.mock('@/lib/catalog/publish', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/catalog/publish')>();
    return {
        ...actual,
        publish: (options: Parameters<typeof actual.publish>[0]) => {
            const answer = stand.next;
            stand.next = null;
            return answer ? Promise.resolve(answer) : actual.publish(options);
        },
    };
});
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

const validate = (screen: ScreenView) => publishAction(IDLE_STATE, form({ intent: 'validate', draftId: screen.draftId, active: screen.active.revisionId }));

/** A launched catalog with a pending draft: the three warning rules' cases, or one harmless title change. */
async function launched(seed: number, { warnings }: { warnings: boolean }) {
    const catalog = await createTestCatalog({ seed, photos: 3, series: [{ title: 'Fixture harbor' }, { title: 'Fixture other' }], variantBytes: VARIANT_BYTES });
    const root = catalog.root;
    expect(await publish({ dataRoot: root, actor: 'test', confirmLaunch: true, logger: quiet })).toMatchObject({ outcome: 'PUBLISHED', warnings: 0 });
    const layer = await readWorkingLayer(root);
    const series = layer.series[1];
    if (warnings) {
        // A description with camera details, one past 250 characters, and two series with one title.
        const [first, second] = layer.photos;
        await writeAuthoredRecord({ ...first, alt: { kind: 'described', text: 'A fixture street at dusk, shot at 35mm.', reviewed: true } }, { expectedVersion: first.version, root });
        await writeAuthoredRecord({ ...second, alt: { kind: 'described', text: `A fixture description ${'that runs on '.repeat(25)}`, reviewed: true } }, { expectedVersion: second.version, root });
        await writeAuthoredRecord({ ...series, title: 'FIXTURE HARBOR' }, { expectedVersion: series.version, root });
    } else {
        await writeAuthoredRecord({ ...series, title: 'Fixture other harbor' }, { expectedVersion: series.version, root });
    }
    return { catalog, root, photoIds: layer.photos.map((photo) => photo.id) };
}

async function setSourceHealth(root: string, photoId: string, sourceHealth: SourceHealth): Promise<void> {
    const registry = await readRegistry(root);
    await writeRegistry(root, { ...registry, photos: { ...registry.photos, [photoId]: { ...registry.photos[photoId], sourceHealth } } }, registry.version);
}

const codes = (screen: Pick<ScreenView, 'warnings'>) => (screen.warnings ?? []).map((warning) => warning.message);

describe('the Publish screen with warnings', () => {
    it("lists all three rules' warnings after Validate and on the next load, counts them as photos validate and the activation do, and publishes with them", { timeout: 120_000 }, async () => {
        const { root } = await launched(161, { warnings: true });
        const restore = setDataDir(root);
        try {
            const loaded = await view();
            expect(loaded.kind).toBe('ledger');
            const validated = await validate(loaded);
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
            // Every load checks the draft itself, so the page lists the same ones, before a Validate and after.
            expect(codes(loaded)).toEqual(words);
            expect(codes(await view())).toEqual(words);

            const published = await publishAction(validated, form({ intent: 'publish', draftId: loaded.draftId, active: loaded.active.revisionId, validated: loaded.draftId }));
            expect(published.answer).toMatchObject({ kind: 'published', live: { revisionId: loaded.draftId } });
            expect((await listActivations(root)).at(-1)).toMatchObject({ revisionId: loaded.draftId, validation: { errors: 0, warnings: 4 } });
        } finally {
            restore();
        }
    });

    it("follows the registry's source health on every load, which the draft's ID doesn't cover: missing after a Validate, then restored", { timeout: 120_000 }, async () => {
        const { root, photoIds } = await launched(162, { warnings: false });
        const restore = setDataDir(root);
        try {
            const loaded = await view();
            const missing = /^The source file of .+ is missing\./;
            expect((await validate(loaded)).answer).toMatchObject({ kind: 'valid', warnings: [] });
            expect(codes(await view())).toEqual([]);
            // The owner's file goes missing after the dry run: the next load says so.
            await setSourceHealth(root, photoIds[2], 'missing');
            const after = await view();
            expect(after.draftId).toBe(loaded.draftId);
            expect(codes(after)).toEqual([expect.stringMatching(missing)]);
            expect((await validate(after)).answer).toMatchObject({ kind: 'valid', warnings: [expect.objectContaining({ message: expect.stringMatching(missing) })] });
            // He puts it back: the next load lists nothing, as Source health says it's present.
            await setSourceHealth(root, photoIds[2], 'present');
            const back = await view();
            expect(back.draftId).toBe(loaded.draftId);
            expect(codes(back)).toEqual([]);
        } finally {
            restore();
        }
    });

    it('lists the warnings beside the blockers when Validate is refused, and when Publish finds an error at the switch', { timeout: 120_000 }, async () => {
        const { root } = await launched(163, { warnings: true });
        const restore = setDataDir(root);
        try {
            const loaded = await view();
            const passed = await publish({ dataRoot: root, actor: 'test', dryRun: true, expectedRevisionId: loaded.draftId, logger: quiet });
            expect(passed).toMatchObject({ outcome: 'DRY_RUN_OK', warnings: 4 });
            const words = passed.issues.map((issue) => issue.message);
            const error: Issue = { code: 'description.series-copy', severity: 'error', record: { kind: 'series', id: 'ser_fixture-01' }, field: 'shortStatement', message: 'A published series needs a short statement.' };
            const refused: PublishResult = { ...passed, outcome: 'VALIDATION_FAILED', errors: 1, issues: [...passed.issues, error] };

            stand.next = refused;
            const blocked = (await validate(loaded)).answer;
            if (blocked?.kind !== 'blocked') throw new Error(`Validate answered ${blocked?.kind}`);
            expect(blocked.blockers).toHaveLength(1);
            expect(blocked.warnings?.map((warning) => warning.message)).toEqual(words);

            const valid = await validate(loaded);
            stand.next = refused;
            const atPublish = (await publishAction(valid, form({ intent: 'publish', draftId: loaded.draftId, active: loaded.active.revisionId, validated: loaded.draftId }))).answer;
            if (atPublish?.kind !== 'blocked-at-publish') throw new Error(`Publish answered ${atPublish?.kind}`);
            expect(atPublish.blockers).toHaveLength(1);
            expect(atPublish.warnings?.map((warning) => warning.message)).toEqual(words);
        } finally {
            stand.next = null;
            restore();
        }
    });
});
