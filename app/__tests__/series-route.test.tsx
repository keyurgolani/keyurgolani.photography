import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { photoEntryName } from '@/lib/a11y/photoName';
import type { SeriesPhotoProps } from '@/components/series/SeriesPhoto';
import type { ActiveCatalog } from '@/lib/catalog/public-reader';
import { createCatalogReader, type CatalogContent } from '@/lib/catalog/reader';
import { createTestCatalog, type TestCatalog } from '@/lib/catalog/testing';
import type { RevisionContent } from '@/lib/catalog/types';
import { REPO_ROOT } from '../../test/helpers/runTsx';

// /work/[slug]'s request-time answers (#5): the page and generateMetadata
// over seriesPageFrom() with getActiveCatalog() and publicRoutes, as a
// render, a 308, the one not-found, or a throw to app/error.tsx.

const state = vi.hoisted(() => ({
    catalog: null as unknown,
    origin: null as URL | null,
    loads: 0,
    photoProps: [] as unknown[],
    returnProps: [] as unknown[],
}));

/** What Next's notFound() throws, reduced to one value, so every not-found case can be compared to the others. */
const NOT_FOUND = vi.hoisted(() => new Error('NEXT_HTTP_ERROR_FALLBACK;404'));

/** What permanentRedirect() and redirect() throw, reduced to the facts the tests read. */
const Redirected = vi.hoisted(
    () =>
        class Redirected extends Error {
            constructor(readonly location: string, readonly status: 307 | 308) {
                super(`${status} ${location}`);
            }
        },
);

vi.mock('next/navigation', () => ({
    notFound: () => {
        throw NOT_FOUND;
    },
    permanentRedirect: (location: string) => {
        throw new Redirected(location, 308);
    },
    redirect: (location: string) => {
        throw new Redirected(location, 307);
    },
    usePathname: () => '/work/fixture-a',
}));

vi.mock('@/lib/catalog/public-reader', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/catalog/public-reader')>();
    return {
        ...actual,
        getActiveCatalog: async () => {
            state.loads += 1;
            return state.catalog;
        },
    };
});

vi.mock('@/lib/site/config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/site/config')>();
    return { ...actual, getSiteOrigin: () => state.origin };
});

vi.mock('@/components/site/SiteNav', () => ({ default: () => <nav aria-label="Primary" /> }));

// Every prop a client component takes ships to visitors, so the tests read what SeriesPhoto gets.
vi.mock('@/components/series/SeriesPhoto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/series/SeriesPhoto')>();
    return {
        default: (props: SeriesPhotoProps) => {
            state.photoProps.push(props);
            return actual.default(props);
        },
    };
});

vi.mock('@/components/series/SeriesReturn', () => ({
    default: (props: unknown) => {
        state.returnProps.push(props);
        return null;
    },
}));

const routeModule = await import('../work/[slug]/page');
const { default: SeriesRoute, generateMetadata, dynamic } = routeModule;
const { CatalogUnavailableError } = await import('@/lib/catalog/public-reader');
const { mediaUrl } = await import('@/lib/media/url');

const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = Array.from({ length: 10 }, (_, n) => id(n + 1));
/** Not in the catalog at all, so the reader skips it. */
const DANGLING = id(99);

/**
 * fixture-a (once old-fixture-a) holds P[0] to P[5] in authored order P[0],
 * P[3], P[1], P[2], P[4], P[5], so ID order and authored order differ. Its
 * cover is P[1], third. A lead run of two, then chapters at positions 3 and
 * 5. P[0] is titled and located; P[3] is decorative; P[4] is undated. B
 * holds P[6] alone. The draft and hidden series and their former slugs, and
 * every field outside the page's allowlist, carry sentinel strings.
 */
const ORDER_A = [P[0], P[3], P[1], P[2], P[4], P[5]];

const SENTINELS = [
    'SENTINEL draft title',
    'sentinel-draft',
    'sentinel-old-draft',
    'SENTINEL hidden title',
    'sentinel-hidden',
    'sentinel-old-hidden',
    'old-fixture-a',
    'SENTINEL caption',
    'SENTINEL credit',
    'SENTINEL make',
    'private/SENTINEL-source.jpg',
    '#5e7173',
    '#a1b2c3',
    'ser_fixture-draft',
    'ser_fixture-hidden',
    // Capture days: the page ships years only.
    '2019-05-06',
    // The draft and hidden series' photos, and one in no series.
    P[7],
    P[8],
    P[9],
];

let catalog: TestCatalog;
let content: RevisionContent;

beforeAll(async () => {
    catalog = await createTestCatalog({
        seed: 55,
        photos: [
            {
                id: P[0],
                title: 'Fixture title one',
                caption: 'SENTINEL caption',
                credit: 'SENTINEL credit',
                technical: { Make: 'SENTINEL make' },
                location: 'Fixture location one',
                capturedAt: '2019-05-06',
                accent: '#a1b2c3',
                sourcePath: 'private/SENTINEL-source.jpg',
            },
            { id: P[1], location: 'Fixture location two', crop: 'contain' },
            { id: P[2] },
            { id: P[3], alt: { kind: 'decorative' } },
            { id: P[4], capturedDate: null },
            { id: P[5] },
            { id: P[6] },
            { id: P[7] },
            { id: P[8] },
            { id: P[9] },
        ],
        series: [
            {
                id: 'ser_fixture-a',
                slug: 'fixture-a',
                title: 'Fixture series A',
                shortStatement: 'Fixture short statement A.',
                slugAliases: ['old-fixture-a'],
                statement: 'Fixture statement, first paragraph.\n\nSecond <b>paragraph</b> & more.',
                accent: '#5e7173',
                photoIds: ORDER_A,
                cover: { photoId: P[1], focalPoint: { x: 0.25, y: 0.75 } },
                chapters: [
                    { id: 'ch-one', title: 'Fixture chapter one', startPhotoId: P[1] },
                    { id: 'ch-two', title: 'Fixture chapter two', startPhotoId: P[4] },
                ],
            },
            { id: 'ser_fixture-b', slug: 'fixture-b', title: 'Fixture series B', shortStatement: '  ', photoIds: [P[6]], cover: { photoId: P[6] } },
            { id: 'ser_fixture-draft', slug: 'sentinel-draft', slugAliases: ['sentinel-old-draft'], title: 'SENTINEL draft title', photoIds: [P[7]], visibility: 'draft' },
            { id: 'ser_fixture-hidden', slug: 'sentinel-hidden', slugAliases: ['sentinel-old-hidden'], title: 'SENTINEL hidden title', photoIds: [P[8]], visibility: 'hidden' },
        ],
    });
    content = structuredClone(catalog.content) as RevisionContent;
});

afterAll(async () => {
    await catalog?.cleanup();
});

const REVISION = `rev_${'5'.repeat(64)}`;

function served(source: CatalogContent = content, servedState: 'ok' | 'degraded' = 'ok'): ActiveCatalog {
    return {
        mode: 'catalog',
        state: servedState,
        reader: createCatalogReader(source, { revisionId: REVISION, revisionNumber: 4 }),
        active: { revisionId: REVISION, revisionNumber: 4, activationId: 'act_fixture', activatedAt: null },
    } as unknown as ActiveCatalog;
}

const unavailable = (reason: 'catalog-unreadable' | 'active-unreadable' | 'revision-unreadable'): ActiveCatalog => ({ mode: 'catalog', state: 'unavailable', reason });

const props = (slug: string) => ({ params: Promise.resolve({ slug }) });

type Answer = { html: string } | { redirect: InstanceType<typeof Redirected> } | { notFound: true } | { thrown: unknown };

async function answer(slug: string): Promise<Answer> {
    try {
        return { html: renderToStaticMarkup(await SeriesRoute(props(slug))) };
    } catch (error) {
        if (error === NOT_FOUND) return { notFound: true };
        if (error instanceof Redirected) return { redirect: error };
        return { thrown: error };
    }
}

async function html(slug = 'fixture-a'): Promise<string> {
    const result = await answer(slug);
    if (!('html' in result)) throw new Error(`/work/${slug} did not render: ${JSON.stringify(result)}`);
    return result.html;
}

async function documentOf(slug = 'fixture-a'): Promise<Document> {
    return new DOMParser().parseFromString(await html(slug), 'text/html');
}

const photoOf = (photoId: string) => {
    const photo = content.photos.find((record) => record.id === photoId);
    if (!photo) throw new Error(`No ${photoId} in the content`);
    return photo;
};
const describedText = (photoId: string) => {
    const { alt } = photoOf(photoId);
    return alt.kind === 'described' ? alt.text : null;
};

/** The sequence entries, in DOM order. */
const entriesOf = (doc: Document) => [...doc.querySelectorAll<HTMLAnchorElement>('main ol > li > a')];

beforeEach(() => {
    state.catalog = served();
    state.origin = null;
    state.loads = 0;
    state.photoProps = [];
    state.returnProps = [];
});

describe('/work/[slug] renders per request', () => {
    it('is force-dynamic, with no static params, revalidate, or cache', () => {
        expect(dynamic).toBe('force-dynamic');
        expect(Object.keys(routeModule).sort()).toEqual(['default', 'dynamic', 'generateMetadata']);
        const source = fs.readFileSync(path.join(REPO_ROOT, 'app/work/[slug]/page.tsx'), 'utf8');
        expect(source).not.toMatch(/['"]use cache['"]|unstable_cache|generateStaticParams|revalidate\s*=/);
    });

    it('has no loading.tsx at app/, app/work/, or app/work/[slug]/, so a 404 or a 308 is never sent after a streamed 200 shell', () => {
        for (const dir of ['app', 'app/work', 'app/work/[slug]']) {
            for (const name of ['loading.tsx', 'loading.ts', 'loading.jsx', 'loading.js']) expect(fs.existsSync(path.join(REPO_ROOT, dir, name)), `${dir}/${name}`).toBe(false);
        }
        const source = fs.readFileSync(path.join(REPO_ROOT, 'app/work/[slug]/page.tsx'), 'utf8');
        expect(source).not.toContain('<Suspense');
    });
});

describe('route generation and visibility', () => {
    it.each(['ok', 'degraded'] as const)('renders the canonical slug of a published series from the served revision (%s), with SiteNav before and outside main', async (servedState) => {
        state.catalog = served(content, servedState);
        const page = await html();
        expect(page.indexOf('<nav aria-label="Primary">')).toBeGreaterThanOrEqual(0);
        expect(page.indexOf('<nav aria-label="Primary">')).toBeLessThan(page.indexOf('<main'));
        const doc = new DOMParser().parseFromString(page, 'text/html');
        expect(doc.querySelectorAll('main nav')).toHaveLength(0);
        expect(doc.querySelector('h1')?.textContent).toBe('Fixture series A');
        expect(doc.querySelector('[data-surface]')).toBeNull();
    });

    it('reads the catalog once per answer', async () => {
        await html();
        expect(state.loads).toBe(1);
    });

    /** Every slug that must answer exactly like an unknown one. */
    const NOT_FOUND_SLUGS = [
        ['an unknown slug', 'no-such-series'],
        ['a draft series', 'sentinel-draft'],
        ['a draft series\' former slug', 'sentinel-old-draft'],
        ['a hidden series', 'sentinel-hidden'],
        ['a hidden series\' former slug', 'sentinel-old-hidden'],
        ['a series ID', 'ser_fixture-a'],
        ['a photo ID', P[0]],
        ['an uppercase variant', 'Fixture-A'],
        ['a dot segment', '..'],
        ['an encoded slash', 'fixture-a%2F..'],
        ['a slug over 64 characters', 'a'.repeat(65)],
        ['an empty slug', ''],
    ] as const;

    it.each(NOT_FOUND_SLUGS)('answers %s with the one not-found, and empty metadata', async (_name, slug) => {
        expect(await answer(slug)).toEqual({ notFound: true });
        expect(await generateMetadata(props(slug))).toEqual({});
    });

    it('answers every not-found case with the same thrown value and the same metadata, so nothing tells them apart', async () => {
        const answers = [];
        for (const [, slug] of NOT_FOUND_SLUGS) answers.push({ page: await answer(slug), metadata: JSON.stringify(await generateMetadata(props(slug))) });
        state.catalog = { mode: 'legacy' } satisfies ActiveCatalog;
        answers.push({ page: await answer('fixture-a'), metadata: JSON.stringify(await generateMetadata(props('fixture-a'))) });
        expect(new Set(answers.map((entry) => JSON.stringify(entry))).size).toBe(1);
    });

    it('answers a malformed slug without reading the catalog', async () => {
        for (const slug of ['Fixture-A', '..', 'a'.repeat(65), '']) {
            await answer(slug);
            await generateMetadata(props(slug));
        }
        expect(state.loads).toBe(0);
    });

    it('answers a published slug not-found in legacy mode, since no series exists before the cutover', async () => {
        state.catalog = { mode: 'legacy' } satisfies ActiveCatalog;
        expect(await answer('fixture-a')).toEqual({ notFound: true });
        expect(await answer('old-fixture-a')).toEqual({ notFound: true });
        expect(await generateMetadata(props('fixture-a'))).toEqual({});
    });

    it('answers a series with no member that resolves not-found, as Work leaves it out', async () => {
        const emptied = structuredClone(content);
        emptied.series[1].photoIds = [DANGLING];
        state.catalog = served(emptied);
        expect(await answer('fixture-b')).toEqual({ notFound: true });
        expect(await generateMetadata(props('fixture-b'))).toEqual({});
    });
});

describe('redirects', () => {
    it.each(['ok', 'degraded'] as const)('answers a former slug with a 308 to the canonical series path (%s), and empty metadata', async (servedState) => {
        state.catalog = served(content, servedState);
        const result = await answer('old-fixture-a');
        expect(result).toEqual({ redirect: expect.objectContaining({ location: '/work/fixture-a', status: 308 }) });
        expect(await generateMetadata(props('old-fixture-a'))).toEqual({});
    });

    it('sends no redirect while the catalog is unavailable, only the error', async () => {
        state.catalog = unavailable('active-unreadable');
        const result = await answer('old-fixture-a');
        expect(result).toEqual({ thrown: expect.any(CatalogUnavailableError) });
    });
});

describe('while the catalog is unavailable', () => {
    it.each(['catalog-unreadable', 'active-unreadable', 'revision-unreadable'] as const)('(%s) throws CatalogUnavailableError for app/error.tsx, never a not-found', async (reason) => {
        state.catalog = unavailable(reason);
        for (const slug of ['fixture-a', 'no-such-series', 'sentinel-draft']) {
            const result = await answer(slug);
            expect(result).toEqual({ thrown: expect.any(CatalogUnavailableError) });
            expect((result as { thrown: InstanceType<typeof CatalogUnavailableError> }).thrown.reason).toBe(reason);
            expect(await generateMetadata(props(slug))).toEqual({});
        }
    });
});

describe('generateMetadata on a published series', () => {
    const cover = () => photoOf(P[1]);
    const shareUrl = () => mediaUrl({ photoId: P[1], assetRevision: cover().assetRevision, profileId: cover().profileId }, 'w1200', 'webp');

    it('with SITE_URL set gives the title, short statement, canonical path, and the cover\'s 1200 px WebP over the site\'s Open Graph fields', async () => {
        state.origin = new URL('https://photos.example.test');
        const share = cover().variants.w1200.webp;
        expect(await generateMetadata(props('fixture-a'))).toEqual({
            title: 'Fixture series A',
            description: 'Fixture short statement A.',
            alternates: { canonical: '/work/fixture-a' },
            openGraph: {
                siteName: 'Keyur Golani Photography',
                type: 'website',
                url: '/work/fixture-a',
                images: [{ url: shareUrl(), width: share.width, height: share.height, alt: describedText(P[1]) }],
            },
        });
    });

    it('leaves the canonical link, og:url, and the share image out without a valid SITE_URL, instead of pointing them at localhost', async () => {
        state.origin = null;
        const metadata = await generateMetadata(props('fixture-a'));
        expect(metadata).toEqual({
            title: 'Fixture series A',
            description: 'Fixture short statement A.',
            openGraph: { siteName: 'Keyur Golani Photography', type: 'website' },
        });
        expect(JSON.stringify(metadata)).not.toMatch(/localhost|https?:/);
    });

    it('names a decorative cover "<title>, cover photograph", and leaves a blank short statement to the site\'s description', async () => {
        state.origin = new URL('https://photos.example.test');
        const decorative = structuredClone(content);
        const photo = decorative.photos.find((record) => record.id === P[6]);
        if (!photo) throw new Error('No P[6]');
        photo.alt = { kind: 'decorative' };
        state.catalog = served(decorative);
        const metadata = await generateMetadata(props('fixture-b'));
        expect(metadata).not.toHaveProperty('description');
        expect(metadata.openGraph).toEqual(expect.objectContaining({ images: [expect.objectContaining({ alt: 'Fixture series B, cover photograph' })] }));
    });

    it('keeps the canonical link but leaves the share image out when the cover can\'t be shown', async () => {
        state.origin = new URL('https://photos.example.test');
        const broken = structuredClone(content);
        const photo = broken.photos.find((record) => record.id === P[1]);
        if (!photo) throw new Error('No P[1]');
        photo.variants.w1200.webp.url = '/media/elsewhere.webp';
        state.catalog = served(broken);
        const metadata = await generateMetadata(props('fixture-a'));
        expect(metadata.alternates).toEqual({ canonical: '/work/fixture-a' });
        expect(metadata.openGraph).toEqual({ siteName: 'Keyur Golani Photography', type: 'website', url: '/work/fixture-a' });
    });

    it('takes nothing from outside the series record: no sentinel, alias, or other series', async () => {
        state.origin = new URL('https://photos.example.test');
        const text = JSON.stringify(await generateMetadata(props('fixture-a')));
        for (const sentinel of SENTINELS) expect(text, sentinel).not.toContain(sentinel);
    });
});

describe('the page', () => {
    it('opens with the title and the statement as plain-text paragraphs', async () => {
        const doc = await documentOf();
        const header = doc.querySelector('main article header');
        expect(header?.querySelector('h1')?.textContent).toBe('Fixture series A');
        const paragraphs = [...(header?.querySelectorAll('h1 + div > p') ?? [])].map((p) => p.textContent);
        expect(paragraphs).toEqual(['Fixture statement, first paragraph.', 'Second <b>paragraph</b> & more.']);
        expect(doc.querySelector('main b')).toBeNull();
    });

    it('sets the derived facts apart under their own heading, each naming its source', async () => {
        const doc = await documentOf();
        const facts = doc.querySelector('section[aria-labelledby="series-facts"]');
        expect(facts?.querySelector('h2')?.textContent).toBe('From the published photographs');
        const rows = [...(facts?.querySelectorAll('dl > div') ?? [])].map((row) => ({
            term: row.querySelector('dt')?.textContent,
            source: row.querySelector('dd')?.getAttribute('data-source'),
            text: row.querySelector('dd')?.textContent,
        }));
        const derived = content.series[0].derived;
        const years = [derived.capturedFrom, derived.capturedTo].map((date) => date?.slice(0, 4));
        expect(rows).toEqual([
            { term: 'Photographs', source: 'published-sequence', text: '6Counted from the published sequence' },
            { term: 'Captured', source: 'capture-dates', text: `${years[0]} to ${years[1]}From capture dates, 5 of 6 dated` },
            { term: 'Locations', source: 'photograph-records', text: 'Fixture location one, Fixture location twoFrom the photograph records' },
        ]);
    });

    it('shows one year when every date falls in it, and no Captured row when nothing is dated', async () => {
        const doc = await documentOf('fixture-b');
        const terms = [...doc.querySelectorAll('section[aria-labelledby="series-facts"] dt')].map((term) => term.textContent);
        expect(terms).toEqual(['Photographs', 'Captured']);
        const year = content.series[1].derived.capturedFrom?.slice(0, 4);
        expect(doc.querySelector('dd[data-source="capture-dates"]')?.textContent).toBe(`${year}From capture dates`);
        const undated = structuredClone(content);
        for (const photo of undated.photos) delete photo.capturedAt;
        delete undated.series[1].derived.capturedFrom;
        delete undated.series[1].derived.capturedTo;
        state.catalog = served(undated);
        const bare = await documentOf('fixture-b');
        expect([...bare.querySelectorAll('section[aria-labelledby="series-facts"] dt')].map((term) => term.textContent)).toEqual(['Photographs']);
    });

    it('shows the cover as the one decisive photograph, loaded at once, with its description, focal point, and crop', async () => {
        const doc = await documentOf();
        const figure = doc.querySelector('main figure');
        const img = figure?.querySelector('img');
        // The description names the cover's link, so the image inside it has an empty alt (contract rule 1).
        expect(figure?.querySelector('a')?.getAttribute('aria-label')).toContain(describedText(P[1])?.replace(/[\s.,;:]+$/, ''));
        expect(img?.getAttribute('alt')).toBe('');
        expect(img?.getAttribute('loading')).toBe('eager');
        expect(img?.getAttribute('fetchpriority')).toBe('high');
        expect(img?.getAttribute('src')).toBe(photoOf(P[1]).variants.w1200.webp.url);
        expect(figure?.querySelector('figcaption')?.textContent).toBe('Photograph 3 of 6');
        const frame = figure?.querySelector('[data-photo]');
        expect(frame?.getAttribute('data-photo')).toBe('contain');
        expect(frame?.getAttribute('style')).toContain('--focal-x:25%');
        expect(frame?.getAttribute('style')).toContain('--focal-y:75%');
        const { width, height } = photoOf(P[1]);
        expect(frame?.getAttribute('style')).toContain(`aspect-ratio:${width} / ${height}`);
        expect(frame?.getAttribute('style')).toContain(`--ratio:${width} / ${height}`);
        // The only image with a placeholder, and the only one loaded at once.
        expect(doc.querySelectorAll('img[loading="eager"]')).toHaveLength(1);
        expect([...doc.querySelectorAll('img')].filter((image) => image.getAttribute('style')?.includes('background-image'))).toHaveLength(1);
    });

    it('lists the sequence in authored order, each entry one link to its canonical Viewer URL with a stable photo-<photoId> ID', async () => {
        const doc = await documentOf();
        const entries = entriesOf(doc);
        expect(entries.map((entry) => entry.getAttribute('href'))).toEqual(ORDER_A.map((photoId) => `/work/fixture-a/photo/${photoId}`));
        expect(entries.map((entry) => entry.id)).toEqual(ORDER_A.map((photoId) => `photo-${photoId}`));
        expect(entries.map((entry) => entry.querySelector('[data-position]')?.textContent)).toEqual(['1', '2', '3', '4', '5', '6']);
    });

    it('names each entry with photoEntryName(), unique, and gives its image an empty alt inside the named link', async () => {
        const doc = await documentOf();
        const entries = entriesOf(doc);
        const names = entries.map((entry) => entry.getAttribute('aria-label'));
        expect(names).toEqual(
            ORDER_A.map((photoId, index) => {
                const text = describedText(photoId);
                return photoEntryName({ alt: text === null ? { kind: 'decorative' } : { kind: 'described', text }, position: index + 1, total: 6 });
            }),
        );
        expect(names[1]).toBe('Photograph 2 of 6');
        expect(new Set(names).size).toBe(names.length);
        for (const entry of entries) for (const img of entry.querySelectorAll('img')) expect(img.getAttribute('alt')).toBe('');
    });

    it('keeps each entry\'s visible text, its number, inside its name (WCAG 2.5.3)', async () => {
        for (const entry of entriesOf(await documentOf())) {
            const visible = entry.textContent ?? '';
            expect(visible).toMatch(/^\d+$/);
            expect(entry.getAttribute('aria-label')).toMatch(new RegExp(`\\bphotograph ${visible} of \\d+$`, 'i'));
        }
    });

    it('shows each entry\'s position, title, and description without hover', async () => {
        const doc = await documentOf();
        const items = [...doc.querySelectorAll('main ol > li')];
        const first = items[0];
        expect(first.querySelector('a [data-position]')?.textContent).toBe('1');
        expect(first.querySelector('p')?.textContent).toBe(`Fixture title one${describedText(P[0])}`);
        // The decorative photo has no text to show.
        expect(items[1].querySelector('p')).toBeNull();
        expect(items[2].querySelector('p')?.textContent).toBe(describedText(P[1]));
    });

    it('cuts chapters out of the one order: a lead run, then each chapter\'s list starting at its position', async () => {
        const doc = await documentOf();
        const sequence = doc.querySelector('section[aria-labelledby="series-sequence"]');
        expect(sequence?.querySelector('h2')?.textContent).toBe('Sequence');
        const lists = [...(sequence?.querySelectorAll('ol') ?? [])].map((list) => ({
            heading: list.closest('section[aria-labelledby^="series-chapter-"]')?.querySelector('h3')?.textContent ?? null,
            start: list.getAttribute('start'),
            photoIds: [...list.querySelectorAll('a')].map((entry) => entry.id.slice('photo-'.length)),
        }));
        expect(lists).toEqual([
            { heading: null, start: '1', photoIds: [P[0], P[3]] },
            { heading: 'Fixture chapter one', start: '3', photoIds: [P[1], P[2]] },
            { heading: 'Fixture chapter two', start: '5', photoIds: [P[4], P[5]] },
        ]);
        for (const chapter of sequence?.querySelectorAll('section') ?? []) {
            expect(doc.getElementById(chapter.getAttribute('aria-labelledby') ?? '')?.tagName).toBe('H3');
        }
    });

    it('opens on the first chapter with no lead run when the first chapter starts on the first photograph', async () => {
        const moved = structuredClone(content);
        moved.series[0].chapters[0].startPhotoId = P[0];
        state.catalog = served(moved);
        const doc = await documentOf();
        expect([...doc.querySelectorAll('main ol')].map((list) => list.getAttribute('start'))).toEqual(['1', '5']);
        expect(doc.querySelector('main ol')?.closest('section')?.querySelector('h3')?.textContent).toBe('Fixture chapter one');
    });

    it('keeps an entry whose image set can\'t be shown in place, with its position, text, and Viewer link, and the missing-image state', async () => {
        const broken = structuredClone(content);
        const photo = broken.photos.find((record) => record.id === P[2]);
        if (!photo) throw new Error('No P[2]');
        photo.variants.w400.avif.url = '/media/elsewhere.avif';
        state.catalog = served(broken);
        const doc = await documentOf();
        const entry = doc.getElementById(`photo-${P[2]}`);
        expect(entry?.getAttribute('href')).toBe(`/work/fixture-a/photo/${P[2]}`);
        expect(entry?.getAttribute('aria-label')).toBe(photoEntryName({ alt: { kind: 'described', text: describedText(P[2]) ?? '' }, position: 4, total: 6 }));
        expect(entry?.querySelector('img')).toBeNull();
        // No text in the mark, so the link's visible text stays its number, part of its name.
        expect(entry?.querySelector('[data-photo="unavailable"]')?.textContent).toBe('');
        expect(entry?.textContent).toBe('4');
        expect(entry?.closest('li')?.querySelector('p')?.textContent).toBe(describedText(P[2]));
        expect(entriesOf(doc).map((link) => link.id)).toEqual(ORDER_A.map((photoId) => `photo-${photoId}`));
    });

    it('makes the cover one link to its photograph\'s canonical Viewer URL, id series-cover, named apart from its entry', async () => {
        const doc = await documentOf();
        const links = [...doc.querySelectorAll<HTMLAnchorElement>('main figure a')];
        expect(links).toHaveLength(1);
        const [cover] = links;
        expect(cover.id).toBe('series-cover');
        expect(cover.getAttribute('href')).toBe(`/work/fixture-a/photo/${P[1]}`);
        const entryName = photoEntryName({ alt: { kind: 'described', text: describedText(P[1]) ?? '' }, position: 3, total: 6 });
        expect(cover.getAttribute('aria-label')).toBe(`${entryName}, series cover`);
        expect(doc.getElementById(`photo-${P[1]}`)?.getAttribute('aria-label')).toBe(entryName);
        // The image and its box sit inside the link, with no text that would have to be part of its name. The position stays outside.
        expect(cover.querySelector('[data-photo]')).not.toBeNull();
        expect(cover.textContent).toBe('');
        expect(cover.closest('figure')?.querySelector('figcaption')?.closest('a')).toBeNull();
        // The link takes the photograph's own ratio, so the width cap and the ring fit it.
        const { width, height } = photoOf(P[1]);
        expect(cover.getAttribute('style')).toContain(`--ratio:${width} / ${height}`);
    });

    it('names a decorative cover by its position, still apart from its entry', async () => {
        const decorative = structuredClone(content);
        const photo = decorative.photos.find((record) => record.id === P[1]);
        if (!photo) throw new Error('No P[1]');
        photo.alt = { kind: 'decorative' };
        state.catalog = served(decorative);
        const doc = await documentOf();
        expect(doc.getElementById('series-cover')?.getAttribute('aria-label')).toBe('Photograph 3 of 6, series cover');
        expect(doc.getElementById(`photo-${P[1]}`)?.getAttribute('aria-label')).toBe('Photograph 3 of 6');
    });

    it('opens text-led, with no stage, when the cover can\'t be shown, and keeps the cover\'s entry', async () => {
        const broken = structuredClone(content);
        const photo = broken.photos.find((record) => record.id === P[1]);
        if (!photo) throw new Error('No P[1]');
        photo.width = 0;
        state.catalog = served(broken);
        const doc = await documentOf();
        expect(doc.querySelector('main figure')).toBeNull();
        expect(doc.getElementById('series-cover')).toBeNull();
        expect(doc.getElementById(`photo-${P[1]}`)?.querySelector('[data-photo="unavailable"]')).not.toBeNull();
    });

    it('skips a member that resolves to nothing and numbers the rest, as the Viewer does', async () => {
        const dangling = structuredClone(content);
        dangling.series[0].photoIds = [P[0], DANGLING, ...ORDER_A.slice(1)];
        state.catalog = served(dangling);
        const doc = await documentOf();
        expect(doc.body.innerHTML).not.toContain(DANGLING);
        expect(entriesOf(doc).map((entry) => entry.id)).toEqual(ORDER_A.map((photoId) => `photo-${photoId}`));
        expect(entriesOf(doc).at(-1)?.getAttribute('aria-label')).toMatch(/, photograph 6 of 6$/);
    });

    it('renders a one-photograph series with its one entry, and Photograph 1 of 1 on the cover', async () => {
        const doc = await documentOf('fixture-b');
        expect(entriesOf(doc).map((entry) => entry.getAttribute('href'))).toEqual([`/work/fixture-b/photo/${P[6]}`]);
        expect(doc.querySelector('main figcaption')?.textContent).toBe('Photograph 1 of 1');
    });

    it('ends with an All work link to /work after the last entry, and nothing wraps to another series', async () => {
        const doc = await documentOf();
        const links = [...doc.querySelectorAll('main a')];
        expect(links.at(-1)?.textContent).toBe('All work');
        expect(links.at(-1)?.getAttribute('href')).toBe('/work');
        expect(links.filter((link) => !link.getAttribute('href')?.startsWith('/work/fixture-a/photo/')).map((link) => link.getAttribute('href'))).toEqual(['/work']);
    });
});

describe('keyboard and touch order', () => {
    it('makes the cover, the entries, and All work the only focusable things in main, as plain links in DOM order with no tabindex', async () => {
        const doc = await documentOf();
        const focusable = [...doc.querySelectorAll('main a[href], main button, main input, main select, main textarea, main [tabindex]')];
        expect(focusable.map((element) => element.getAttribute('href'))).toEqual([`/work/fixture-a/photo/${P[1]}`, ...ORDER_A.map((photoId) => `/work/fixture-a/photo/${photoId}`), '/work']);
        expect(focusable[0].id).toBe('series-cover');
        for (const element of focusable) {
            expect(element.tagName).toBe('A');
            expect(element.hasAttribute('tabindex')).toBe(false);
            expect(element.hasAttribute('onclick')).toBe(false);
            // No nested interactive element.
            expect(element.querySelector('a, button, input, [tabindex]')).toBeNull();
        }
    });

    it('lays the entries out in a grid that keeps DOM order: no CSS order, dense packing, or reversed direction', () => {
        // Comments stripped, since they talk about order too.
        const css = fs.readFileSync(path.join(REPO_ROOT, 'components/series/SeriesPage.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        expect(css).not.toMatch(/(^|[\s;{])order\s*:|grid-auto-flow\s*:\s*[^;]*dense|-reverse|masonry/);
        // Hover styles apply only with a fine pointer, so a tap never leaves them behind.
        const hoverRules = [...css.matchAll(/:hover/g)].length;
        const gated = [...css.matchAll(/@media \(hover: hover\) and \(pointer: fine\) \{[^}]*:hover/g)].length;
        expect(hoverRules).toBe(gated);
    });
});

describe('no discovery through the page', () => {
    it('leaves every unpublished and non-allowlisted string out of the server HTML', async () => {
        const page = await html();
        for (const sentinel of SENTINELS) expect(page, sentinel).not.toContain(sentinel);
        expect(page).not.toContain('accent');
    });

    it('hands the client component only an image set from /media, an alt, and its display options', async () => {
        await html();
        expect(state.photoProps.length).toBe(ORDER_A.length + 1);
        const allowed = new Set(['image', 'alt', 'sizes', 'priority', 'focalPoint', 'crop', 'fallbackLabel', 'frameClassName', 'intrinsic']);
        for (const recorded of state.photoProps as SeriesPhotoProps[]) {
            for (const key of Object.keys(recorded)) expect(allowed.has(key), key).toBe(true);
            if (recorded.image === null) continue;
            expect(Object.keys(recorded.image).sort()).toEqual(recorded.image.lqip === undefined ? ['height', 'variants', 'width'] : ['height', 'lqip', 'variants', 'width']);
            for (const formats of Object.values(recorded.image.variants)) for (const file of Object.values(formats)) expect(file.url).toMatch(/^\/media\/ph_/);
        }
        const text = JSON.stringify(state.photoProps);
        for (const sentinel of SENTINELS) expect(text, sentinel).not.toContain(sentinel);
    });

    it('hands the return position only the series path, the canonical slug, the served revision, and the total', async () => {
        await html();
        expect(state.returnProps).toEqual([{ path: '/work/fixture-a', slug: 'fixture-a', revisionId: REVISION, total: ORDER_A.length }]);
    });
});
