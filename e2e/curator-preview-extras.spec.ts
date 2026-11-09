import type { Frame, Page } from '@playwright/test';
import { publish, validateWorkingLayer } from '../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../lib/catalog/testing';
import { readWorkingLayer } from '../lib/catalog/working-layer';
import { writeAuthoredRecord } from '../lib/catalog/working-layer-writer';
import { READY_TIMEOUT } from './support/catalogServer';
import { signIn, startCuratorServer, type CuratorServer } from './support/curatorServer';
import { waitForHydration } from './support/hydration';
import { checkSurface } from './support/surface';
import { expect, test } from './support/test';

// A9 (#182) on the draft preview, as the curator with a test passphrase: a
// former address redirects inside the preview, never to the public site and
// never permanently, for a series page and a photograph's page, and the full
// preview's toolbar has Fit the window, Desktop 1440 × 900 and Mobile
// 390 × 844 as pressed buttons named by their visible text, the draft's
// short hash and Back to Publish, which pass #1's checks at both widths.
// Test values only.

test.describe.configure({ mode: 'serial' });

const HOOK_TIMEOUT = READY_TIMEOUT + 120_000;
const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SERIES = { id: 'ser_e2e-renamed', slug: 'preview-before', renamed: 'preview-after', title: 'Preview renamed series' };

let catalog: TestCatalog | undefined;
let curator: CuratorServer | undefined;
let draftId = '';

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    catalog = await createTestCatalog({
        seed: 182,
        withAssets: true,
        photos: [1, 2, 3].map((n) => ({ id: id(n), width: 1200, height: 800 })),
        series: [{ id: SERIES.id, slug: SERIES.slug, title: SERIES.title, photoIds: [id(1), id(2), id(3)] }],
        featuredSeriesIds: [SERIES.id],
    });
    const root = catalog.root;
    const outcome = await publish({ dataRoot: root, actor: 'e2e', confirmLaunch: true, logger: { log: () => undefined } });
    expect(outcome.outcome, outcome.message).toBe('PUBLISHED');
    // The draft moves the series to a new address and keeps the old one as an alias.
    const record = (await readWorkingLayer(root)).series.find((series) => series.id === SERIES.id);
    if (!record) throw new Error('No series');
    await writeAuthoredRecord({ ...structuredClone(record), slug: SERIES.renamed, slugAliases: [SERIES.slug] }, { expectedVersion: record.version, root });
    const validated = await validateWorkingLayer({ dataRoot: root });
    expect(validated.candidateId).not.toBeNull();
    draftId = validated.candidateId as string;
    curator = await startCuratorServer(root);
});

test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await curator?.stop();
    await catalog?.cleanup();
});

const server = () => {
    if (!curator) throw new Error('The curator server did not start');
    return curator;
};
const origin = () => server().origin;
const site = () => `/curation/preview/${draftId}/site`;

async function signedIn(page: Page): Promise<void> {
    await signIn(page, origin(), server().passphrase);
}

/** The preview site's frame, once its document has loaded. */
async function siteFrame(page: Page): Promise<Frame> {
    const element = page.locator('iframe[title="Visitor preview of the draft catalog"]');
    await expect(element).toBeVisible();
    const frame = await (await element.elementHandle())?.contentFrame();
    if (!frame) throw new Error('The preview frame has no document');
    await frame.waitForLoadState();
    return frame;
}

test('redirects a former address inside the preview, with a temporary redirect, for the series and a photograph', async ({ page }) => {
    await signedIn(page);
    for (const [from, to] of [
        [`${site()}/work/${SERIES.slug}`, `${site()}/work/${SERIES.renamed}`],
        [`${site()}/work/${SERIES.slug}/photo/${id(2)}`, `${site()}/work/${SERIES.renamed}/photo/${id(2)}`],
    ]) {
        const response = await page.request.get(`${origin()}${from}`, { maxRedirects: 0 });
        // A draft's redirect is never permanent, so no browser keeps it once the draft changes.
        expect(response.status(), from).toBe(307);
        expect(new URL(response.headers().location ?? '', origin()).pathname, from).toBe(to);
    }
    // In the frame, the old address lands on the new one, still inside the preview.
    await page.goto(`${origin()}/curation/preview/${draftId}`);
    const frame = await siteFrame(page);
    await frame.goto(`${origin()}${site()}/work/${SERIES.slug}`);
    await expect.poll(() => new URL(frame.url()).pathname).toBe(`${site()}/work/${SERIES.renamed}`);
    await expect(frame.getByRole('heading', { level: 1 })).toHaveText(SERIES.title);
});

test('sizes the frame with the presets and changes nothing else, with the short hash and Back to Publish', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedIn(page);
    await page.goto(`${origin()}/curation/preview/${draftId}`);
    await waitForHydration(page);
    const frame = page.locator('iframe[title="Visitor preview of the draft catalog"]');
    const src = await frame.getAttribute('src');
    // A marker inside the framed page, which a reload would lose.
    const inside = await (await frame.elementHandle())?.contentFrame();
    if (!inside) throw new Error('The preview frame has no document');
    await inside.waitForLoadState();
    await inside.evaluate(() => void ((window as unknown as { kept: string }).kept = 'kept'));
    const kept = () => inside.evaluate(() => (window as unknown as { kept?: string }).kept ?? null);
    await expect(page.getByText(`Draft ${draftId.slice(4, 12)}`)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to Publish' })).toHaveAttribute('href', '/curation/publish');
    await expect(page.getByRole('button', { name: 'Fit the window' })).toHaveAttribute('aria-pressed', 'true');
    for (const [name, width, height] of [
        ['Desktop 1440 × 900', 1440, 900],
        ['Mobile 390 × 844', 390, 844],
    ] as const) {
        await page.getByRole('button', { name }).click();
        await expect(page.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
        // The frame keeps the preset's own size inside, scaled down to fit when the window is smaller.
        await expect.poll(() => frame.evaluate((element) => [(element as HTMLIFrameElement).offsetWidth, (element as HTMLIFrameElement).offsetHeight])).toEqual([width, height]);
        const box = await frame.boundingBox();
        expect(box && Math.abs(box.width / box.height - width / height)).toBeLessThan(0.02);
        expect(box && box.width).toBeLessThanOrEqual(1280);
        // Presets change size only: the same page, never reloaded.
        expect(await frame.getAttribute('src')).toBe(src);
        expect(await kept()).toBe('kept');
    }
    await page.getByRole('button', { name: 'Fit the window' }).click();
    await expect.poll(() => frame.evaluate((element) => (element as HTMLIFrameElement).style.width)).toBe('');
});

test.describe("the #1 checks on the preview's toolbar", () => {
    for (const [width, height] of [
        [1440, 900],
        [390, 844],
    ] as const) {
        test(`pass at ${width} px`, async ({ page }) => {
            await page.setViewportSize({ width, height });
            await signedIn(page);
            await page.goto(`${origin()}/curation/preview/${draftId}`);
            await checkSurface(page, {
                controls: [page.getByRole('group', { name: 'Frame size' }).getByRole('button'), page.getByRole('link', { name: 'Back to Publish' })],
            });
        });
    }
});
