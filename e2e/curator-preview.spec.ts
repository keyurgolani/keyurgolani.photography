import { devices, type APIRequestContext, type APIResponse, type Browser, type BrowserContext, type Frame, type Page } from '@playwright/test';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../lib/identity/variants';
import { publish, validateWorkingLayer } from '../lib/catalog/publish';
import { createTestCatalog, type TestCatalog, type VariantByteTable } from '../lib/catalog/testing';
import { readWorkingLayer } from '../lib/catalog/working-layer';
import { writeAuthoredRecord } from '../lib/catalog/working-layer-writer';
import { READY_TIMEOUT } from './support/catalogServer';
import { signIn, startCuratorServer, type CuratorServer } from './support/curatorServer';
import { expectHomeImmersive } from './support/home';
import { centerOf, holdFinger } from './support/touch';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';

// #16's draft preview on the standalone server (`server.js`, as the image
// runs it), on 127.0.0.1 only, as the curator with a test passphrase:
// anonymous denial with the curator headers on pages, RSC, load-more and
// images, the same for a draft that exists and one that doesn't; the
// draft's own content and none that only the active revision holds; every
// link and request inside the preview; idle Home photo-only in the frame;
// images from the preview's media route, never stored and never through
// `/_next/image`; `frame-ancestors 'self'` on the site subtree only, one CSP
// each; a malformed draft ID; and logout revoking it all.

test.describe.configure({ mode: 'serial' });

const HOOK_TIMEOUT = READY_TIMEOUT + 120_000;
const UNKNOWN = `rev_${'0'.repeat(64)}`;
const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const KEPT = { id: 'ser_e2e-kept', slug: 'preview-kept', title: 'Preview kept series', draftTitle: 'Preview kept series, retitled in the draft' };
const NEW = { id: 'ser_e2e-new', slug: 'preview-new', title: 'Preview series only in the draft' };
const GONE = { id: 'ser_e2e-gone', slug: 'preview-gone', title: 'Preview series only in the active revision' };
const LONG = Array.from({ length: 101 }, (_, n) => id(n + 101));
/** Sparse variant files for the long series: fast to write, never decoded. */
const BYTES = Object.fromEntries(VARIANT_WIDTHS.map((width) => [width, Object.fromEntries(VARIANT_FORMATS.map((format) => [format, 1_024]))])) as VariantByteTable;

let catalog: TestCatalog | undefined;
let long: TestCatalog | undefined;
let curator: CuratorServer | undefined;
let longCurator: CuratorServer | undefined;
let draftId = '';
let longDraftId = '';
let activeId = '';

/** Publish what the catalog holds now, then change its working layer so the draft differs. */
async function publishThen(root: string, change: () => Promise<void>): Promise<{ active: string; draft: string }> {
    const outcome = await publish({ dataRoot: root, actor: 'e2e', confirmLaunch: true, logger: { log: () => undefined } });
    expect(outcome.outcome, outcome.message).toBe('PUBLISHED');
    await change();
    const validated = await validateWorkingLayer({ dataRoot: root });
    expect(validated.candidateId).not.toBeNull();
    expect(validated.candidateId).not.toBe(outcome.revisionId);
    return { active: outcome.revisionId as string, draft: validated.candidateId as string };
}

async function editSeries(root: string, seriesId: string, edit: Record<string, unknown>) {
    const record = (await readWorkingLayer(root)).series.find((series) => series.id === seriesId);
    if (!record) throw new Error(`No series ${seriesId}`);
    await writeAuthoredRecord({ ...structuredClone(record), ...edit }, { expectedVersion: record.version, root });
}

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    catalog = await createTestCatalog({
        seed: 162,
        withAssets: true,
        photos: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: id(n), width: 1200, height: 800 })),
        series: [
            { id: KEPT.id, slug: KEPT.slug, title: KEPT.title, photoIds: [id(1), id(2), id(3)] },
            { id: NEW.id, slug: NEW.slug, title: NEW.title, photoIds: [id(4), id(5)], visibility: 'draft' },
            { id: GONE.id, slug: GONE.slug, title: GONE.title, photoIds: [id(6), id(7)] },
        ],
        featuredSeriesIds: [KEPT.id],
    });
    const root = catalog.root;
    ({ active: activeId, draft: draftId } = await publishThen(root, async () => {
        await editSeries(root, KEPT.id, { title: KEPT.draftTitle });
        await editSeries(root, NEW.id, { visibility: 'published' });
        await editSeries(root, GONE.id, { visibility: 'hidden' });
    }));

    long = await createTestCatalog({
        seed: 163,
        variantBytes: BYTES,
        photos: LONG.map((photoId) => ({ id: photoId, width: 900, height: 600 })),
        series: [{ id: 'ser_e2e-long', slug: 'preview-long', title: 'Preview long series', photoIds: LONG }],
    });
    const longRoot = long.root;
    ({ draft: longDraftId } = await publishThen(longRoot, () => editSeries(longRoot, 'ser_e2e-long', { title: 'Preview long series, retitled' })));

    // E2E_PREVIEW_PORT pins two ports, for a machine that hands out ranges.
    const base = Number(process.env.E2E_PREVIEW_PORT);
    const pinned = Number.isInteger(base) && base > 0;
    curator = await startCuratorServer(root, pinned ? base : undefined, { standalone: true });
    longCurator = await startCuratorServer(longRoot, pinned ? base + 1 : undefined, { standalone: true });
});

test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await curator?.stop();
    await longCurator?.stop();
    await catalog?.cleanup();
    await long?.cleanup();
});

const server = () => {
    if (!curator) throw new Error('The curator server did not start');
    return curator;
};
const origin = () => server().origin;
const base = (draft = draftId) => `/curation/preview/${draft}/site`;
/** A photo's derivative set, from its authored record, since draft-only photos aren't in the published content. */
const photoOf = (photoId: string) => {
    const photo = catalog?.photos.find((entry) => entry.id === photoId);
    if (!photo || !catalog) throw new Error(`No photo ${photoId}`);
    return { id: photo.id, assetRevision: photo.assetRevision, profileId: catalog.profileId };
};
const imagePath = (draft: string, photoId: string) => {
    const photo = photoOf(photoId);
    return `${base(draft)}/media/${photo.id}/${photo.assetRevision}/${photo.profileId}/w400.avif`;
};

/** Every kind of preview request, for one draft ID. */
const previewPaths = (draft: string) => [
    `/curation/preview/${draft}`,
    base(draft),
    `${base(draft)}/work`,
    `${base(draft)}/work/${KEPT.slug}`,
    `${base(draft)}/work/${KEPT.slug}/photo/${id(1)}`,
    `${base(draft)}/api/catalog/series/${KEPT.slug}/pages/x`,
    `${base(draft)}/api/catalog/home/photos/${id(1)}?revision=${draft}`,
    imagePath(draft, id(4)),
    // Paths no route matches, which the preview's catch-all pages answer.
    `/curation/preview/${draft}/anything`,
    `${base(draft)}/gallery`,
    `${base(draft)}/work/${KEPT.slug}/photo/${id(1)}/more`,
];

/** Malformed draft IDs a client sends as they are. */
const MALFORMED = ['rev_x', `rev_${'A'.repeat(64)}`, `rev_${'a'.repeat(65)}`, 'index.json'];

/** Each header a response sent, every copy, by lower-case name. */
function headerCopies(response: APIResponse): Record<string, string[]> {
    const copies: Record<string, string[]> = {};
    for (const { name, value } of response.headersArray()) (copies[name.toLowerCase()] ??= []).push(value);
    return copies;
}

/** What a client can tell from an answer, without the clock. */
async function seen(response: APIResponse) {
    const headers = headerCopies(response);
    delete headers.date;
    delete headers['keep-alive'];
    return { status: response.status(), headers, body: await response.text() };
}

function expectCuratorHeaders(response: APIResponse, frameAncestors: "'none'" | "'self'") {
    const headers = headerCopies(response);
    expect(headers['cache-control']?.join(', '), response.url()).toContain('no-store');
    expect(headers['x-robots-tag'], response.url()).toEqual(['noindex, nofollow']);
    expect(headers['referrer-policy'], response.url()).toEqual(['no-referrer']);
    expect(headers['content-security-policy'], response.url()).toEqual([`frame-ancestors ${frameAncestors}`]);
}

const PUBLIC_REQUEST = /^\/(?:$|work(?:\/|$)|about(?:\/|$)|gallery(?:\/|$)|api\/|media\/|assets\/photos\/)/;
/** What /_next/image may optimize for a preview page: the site's own static portraits (#12's Home intro and About), never a photograph. */
const STATIC_IMAGE = /^\/(?:_next\/static\/media|assets\/profile)\//;

/** Record every request the page and its frames make, to check none leaves the preview. */
function requestLog(page: Page): string[] {
    const log: string[] = [];
    page.on('request', (request) => log.push(request.url()));
    return log;
}

function expectInsidePreview(log: readonly string[], draft = draftId) {
    expect(log.length).toBeGreaterThan(0);
    for (const url of log) {
        const parsed = new URL(url);
        expect(parsed.origin, url).toBe(origin());
        expect(parsed.pathname, url).not.toMatch(PUBLIC_REQUEST);
        if (parsed.pathname.startsWith('/_next/image')) expect(parsed.searchParams.get('url') ?? '', url).toMatch(STATIC_IMAGE);
        if (parsed.pathname.includes('/media/') && !parsed.pathname.startsWith('/_next/')) expect(parsed.pathname.startsWith(`${base(draft)}/media/`), url).toBe(true);
    }
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

/** Every link in a document, as a path. */
async function linkPaths(target: Page | Frame): Promise<string[]> {
    return target.locator('a[href]').evaluateAll((links) => links.map((link) => new URL((link as HTMLAnchorElement).href).pathname));
}

async function signedIn(browser: Browser, at = origin(), passphrase = server().passphrase): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, at, passphrase);
    return { context, page };
}

test.describe('anonymous', () => {
    test('gets the login redirect with the curator headers on every preview request, the same for an existing, an unknown and a malformed draft', async ({ request }) => {
        const anonymous: APIRequestContext = request;
        for (const headers of [{}, { RSC: '1' }] as Record<string, string>[]) {
            const existing = previewPaths(draftId);
            for (const other of [UNKNOWN, ...MALFORMED].map(previewPaths)) {
                for (let at = 0; at < existing.length; at += 1) {
                    const a = await anonymous.get(`${origin()}${existing[at]}`, { maxRedirects: 0, headers });
                    const b = await anonymous.get(`${origin()}${other[at]}`, { maxRedirects: 0, headers });
                    expect(a.status(), existing[at]).toBe(307);
                    expect(new URL(a.headers().location, origin()).pathname, existing[at]).toBe('/curation/login');
                    expectCuratorHeaders(a, "'none'");
                    expect(await seen(a), other[at]).toEqual(await seen(b));
                }
            }
        }
    });
});

test.describe('signed in', () => {
    test('opens the current draft in the frame, with the marker outside the visitor viewport and idle Home photo-only', async ({ browser }) => {
        const { context, page } = await signedIn(browser);
        try {
            const log = requestLog(page);
            await page.goto(`${origin()}/curation/preview`);
            await expect(page).toHaveURL(`${origin()}/curation/preview/${draftId}`);
            await expect(page.getByText('Preview · not public')).toBeVisible();
            const frame = await siteFrame(page);
            expect(new URL(frame.url()).pathname).toBe(base());
            await expect(frame.getByText('Preview · not public')).toHaveCount(0);
            await expectHomeImmersive(frame);
            expectInsidePreview(log.filter((url) => !url.endsWith('/curation/preview')));
        } finally {
            await context.close();
        }
    });

    test('shows the draft on Work, and nothing only the active revision holds, with every link inside the preview', async ({ browser }) => {
        const { context, page } = await signedIn(browser);
        try {
            const log = requestLog(page);
            await page.goto(`${origin()}${base()}/work`);
            await waitForHydration(page);
            const main = page.getByRole('main');
            await expect(main.getByText(KEPT.draftTitle).first()).toBeVisible();
            await expect(main.getByText(NEW.title).first()).toBeVisible();
            await expect(main.getByText(GONE.title)).toHaveCount(0);
            await expect(main.getByText(KEPT.title, { exact: true })).toHaveCount(0);
            for (const path of await linkPaths(page)) expect(path.startsWith(base()), path).toBe(true);
            // Rendered from the draft alone: the active revision's ID appears nowhere.
            expect(await page.content()).not.toContain(activeId);
            expectInsidePreview(log);
        } finally {
            await context.close();
        }
    });

    test("asks for a touched photograph's neighbors (9a) from the preview's own mirror, never the public endpoint", async ({ browser }) => {
        // A phone, with touch: the Viewer asks for its neighbors' peeks once a finger goes down on the photograph.
        const context = await browser.newContext({ ...devices['Pixel 7'] });
        try {
            const page = await context.newPage();
            await signIn(page, origin(), server().passphrase);
            const log = requestLog(page);
            await page.goto(`${origin()}${base()}/work/${NEW.slug}/photo/${id(4)}`);
            await waitForHydration(page);
            const stage = page.locator('[data-viewer-stage]');
            await expect(stage).toBeVisible();
            const peek = page.waitForResponse((response) => new URL(response.url()).pathname === `${base()}/api/catalog/series/${NEW.slug}/photos/${id(5)}`);
            const finger = await holdFinger(page, await centerOf(stage));
            const answer = await peek;
            await finger.lift();
            expect(answer.status()).toBe(200);
            expect(answer.headers()['cache-control']).toContain('no-store');
            expect(JSON.stringify(await answer.json())).toContain(`"${base()}/media/${id(5)}/`);
            expectInsidePreview(log);
        } finally {
            await context.close();
        }
    });

    test('opens a draft-only series and its Viewer under the preview, with Close, Previous and Next inside it', async ({ browser }) => {
        const { context, page } = await signedIn(browser);
        try {
            const log = requestLog(page);
            await page.goto(`${origin()}${base()}/work/${NEW.slug}`);
            await waitForHydration(page);
            await expect(page.getByRole('heading', { level: 1, name: NEW.title })).toBeVisible();
            for (const path of await linkPaths(page)) expect(path.startsWith(base()), path).toBe(true);
            await page.locator(`#photo-${id(4)}`).click();
            await expect(page).toHaveURL(`${origin()}${base()}/work/${NEW.slug}/photo/${id(4)}`);
            await expect(page.locator('[data-surface="viewer"]')).toBeVisible();
            // The shell's Previous and Next move inside the preview.
            await page.getByRole('button', { name: 'Next photograph' }).click();
            await expect(page).toHaveURL(`${origin()}${base()}/work/${NEW.slug}/photo/${id(5)}`);
            await page.getByRole('button', { name: 'Previous photograph' }).click();
            await expect(page).toHaveURL(`${origin()}${base()}/work/${NEW.slug}/photo/${id(4)}`);
            await page.getByRole('button', { name: 'Next photograph' }).click();
            await expect(page).toHaveURL(`${origin()}${base()}/work/${NEW.slug}/photo/${id(5)}`);
            await expect(page.getByRole('link', { name: 'Close' })).toHaveAttribute('href', `${base()}/work/${NEW.slug}`);
            for (const path of await linkPaths(page)) expect(path.startsWith(base()), path).toBe(true);
            // The photograph comes from the preview's media route, never /_next/image. The current one: #89's stage can
            // still hold the photograph it left while it moves.
            const current = page.locator('[data-surface="viewer"] [data-viewer-current] img');
            await expect.poll(() => current.evaluate((image) => new URL((image as HTMLImageElement).currentSrc).pathname)).toMatch(new RegExp(`^${base()}/media/${id(5)}/`));
            expectInsidePreview(log);
            // A series the draft hides is the preview's not-found page, its links inside the preview.
            const hidden = await page.goto(`${origin()}${base()}/work/${GONE.slug}`);
            expect(hidden?.status()).toBe(404);
            await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
            for (const path of await linkPaths(page)) expect(path.startsWith(base()), path).toBe(true);
        } finally {
            await context.close();
        }
    });

    test("serves the draft's images from the preview, never stored, and the public /media still refuses a draft-only set", async ({ browser, request }) => {
        const { context, page } = await signedIn(browser);
        try {
            const image = await page.request.get(`${origin()}${imagePath(draftId, id(4))}`, { maxRedirects: 0 });
            expect(image.status()).toBe(200);
            // The handler sends `private, no-store`, but the curator boundary sets `no-store` first, and Next keeps the
            // first value. Either way it's one header that no cache may store, with nothing that would let one keep it.
            const cacheControl = headerCopies(image)['cache-control'];
            expect(cacheControl).toHaveLength(1);
            expect(cacheControl[0]).toContain('no-store');
            expect(cacheControl[0]).not.toMatch(/public|max-age|s-maxage|immutable/);
            expect(headerCopies(image)['x-robots-tag']).toEqual(['noindex, nofollow']);
            expect(image.headers()['content-type']).toBe('image/avif');
            const photo = photoOf(id(4));
            const publicPath = `/media/${photo.id}/${photo.assetRevision}/${photo.profileId}/w400.avif`;
            expect((await page.request.get(`${origin()}${publicPath}`)).status()).toBe(404);
            expect((await request.get(`${origin()}${publicPath}`)).status()).toBe(404);
            // A set the draft doesn't hold, and a draft that isn't current, are the handler's 404.
            expect((await page.request.get(`${origin()}${imagePath(draftId, id(6))}`)).status()).toBe(404);
            expect((await page.request.get(`${origin()}${imagePath(UNKNOWN, id(4))}`)).status()).toBe(404);
        } finally {
            await context.close();
        }
    });

    test("frames only the site subtree, one CSP per response, and gives every page the preview's metadata", async ({ browser }) => {
        const { context, page } = await signedIn(browser);
        try {
            const frame = await page.request.get(`${origin()}/curation/preview/${draftId}`);
            expect(frame.status()).toBe(200);
            expectCuratorHeaders(frame, "'none'");
            for (const path of [base(), `${base()}/work`, `${base()}/work/${KEPT.slug}`, `${base()}/work/${KEPT.slug}/photo/${id(1)}`, `${base()}/about`]) {
                for (const headers of [{}, { RSC: '1' }] as Record<string, string>[]) {
                    const response = await page.request.get(`${origin()}${path}`, { headers });
                    expect(response.status(), path).toBe(200);
                    expectCuratorHeaders(response, "'self'");
                }
                const html = await (await page.request.get(`${origin()}${path}`)).text();
                expect(html, path).toMatch(/<meta name="robots" content="noindex, nofollow"\/>/);
                expect(html, path).not.toMatch(/<meta (?:property|name)="(?:og|twitter):/);
                expect(html, path).not.toMatch(/<link rel="canonical"/);
                expect(html, path).toMatch(/<title>Preview(?: · [^<]*)?<\/title>/);
            }
            for (const path of ['/curation', '/curation/login', '/curation/preview']) {
                const response = await page.request.get(`${origin()}${path}`, { maxRedirects: 0 });
                expect(headerCopies(response)['content-security-policy'], path).toEqual(["frame-ancestors 'none'"]);
            }
        } finally {
            await context.close();
        }
    });

    test('answers a malformed draft ID with the preview not-found page', async ({ browser }) => {
        const { context, page } = await signedIn(browser);
        try {
            for (const malformed of MALFORMED) {
                for (const path of [`/curation/preview/${malformed}`, `/curation/preview/${malformed}/site`, `/curation/preview/${malformed}/site/work`]) {
                    const response = await page.goto(`${origin()}${path}`);
                    expect(response?.status(), path).toBe(404);
                    await expect(page.getByRole('heading', { name: 'Preview not found' }), path).toBeVisible();
                    expect(await linkPaths(page)).toEqual(['/curation/preview']);
                }
            }
        } finally {
            await context.close();
        }
    });

    test("answers a path no route matches with the preview's not-found page, its links and metadata inside the preview", async ({ browser }) => {
        const { context, page } = await signedIn(browser);
        try {
            for (const draft of [draftId, UNKNOWN]) {
                for (const [path, heading, frameAncestors] of [
                    [`${base(draft)}/gallery`, 'Page not found', "'self'"],
                    [`${base(draft)}/work/${KEPT.slug}/photo/${id(1)}/more`, 'Page not found', "'self'"],
                    [`/curation/preview/${draft}/anything`, 'Preview not found', "'none'"],
                ] as const) {
                    const response = await page.request.get(`${origin()}${path}`);
                    expect(response.status(), path).toBe(404);
                    expectCuratorHeaders(response, frameAncestors);
                    const html = await response.text();
                    expect(html, path).toMatch(/<meta name="robots" content="noindex, nofollow"\/>/);
                    expect(html, path).not.toMatch(/<meta (?:property|name)="(?:og|twitter):/);
                    expect(html, path).not.toMatch(/<link rel="canonical"/);
                    expect(html, path).toMatch(/<title>Preview(?: · [^<]*)?<\/title>/);
                    await page.goto(`${origin()}${path}`);
                    await expect(page.getByRole('heading', { name: heading }), path).toBeVisible();
                    const links = await linkPaths(page);
                    expect(links.length, path).toBeGreaterThan(0);
                    for (const link of links) expect(link.startsWith(heading === 'Page not found' ? base(draft) : '/curation/preview'), `${path} links to ${link}`).toBe(true);
                }
            }
        } finally {
            await context.close();
        }
    });

    test('ends at logout: the preview, its images and its mirrors send the browser to the login again', async ({ browser }) => {
        const { context, page } = await signedIn(browser);
        try {
            expect((await page.request.get(`${origin()}${base()}`)).status()).toBe(200);
            await page.goto(`${origin()}/curation`);
            await waitForHydration(page);
            await page.getByRole('button', { name: 'Sign out' }).click();
            // #87's logout lands on the login with `?signed-out=1`, so the page can say so.
            await expect(page).toHaveURL(`${origin()}/curation/login?signed-out=1`);
            for (const path of previewPaths(draftId)) {
                const response = await page.request.get(`${origin()}${path}`, { maxRedirects: 0 });
                expect(response.status(), path).toBe(307);
                expect(new URL(response.headers().location, origin()).pathname, path).toBe('/curation/login');
            }
            await page.goto(`${origin()}${base()}`);
            await expect(page).toHaveURL(`${origin()}/curation/login`);
        } finally {
            await context.close();
        }
    });
});

test.describe('load-more', () => {
    test("Show more asks the preview's mirror, which answers no-store with no ETag", async ({ browser }) => {
        if (!longCurator) throw new Error('The long curator did not start');
        const at = longCurator.origin;
        const { context, page } = await signedIn(browser, at, longCurator.passphrase);
        try {
            const log = requestLog(page);
            const prefix = `/curation/preview/${longDraftId}/site`;
            await page.goto(`${at}${prefix}/work/preview-long`);
            await waitForHydration(page);
            await expect(page.getByRole('heading', { level: 1, name: 'Preview long series, retitled' })).toBeVisible();
            const answered = page.waitForResponse((response) => new URL(response.url()).pathname.startsWith(`${prefix}/api/catalog/series/preview-long/pages/`));
            await page.getByRole('button', { name: 'Show more photographs' }).click();
            const response = await answered;
            expect(response.status()).toBe(200);
            const headers = await response.allHeaders();
            expect(headers['cache-control']).toContain('no-store');
            expect(headers.etag).toBeUndefined();
            expect(headers['x-robots-tag']).toBe('noindex, nofollow');
            await expect(page.locator(`#photo-${LONG[100]}`)).toBeVisible();
            for (const url of log) {
                const parsed = new URL(url);
                expect(parsed.origin, url).toBe(at);
                expect(parsed.pathname, url).not.toMatch(PUBLIC_REQUEST);
                if (parsed.pathname.startsWith('/_next/image')) expect(parsed.searchParams.get('url') ?? '', url).toMatch(STATIC_IMAGE);
            }
        } finally {
            await context.close();
        }
    });
});
