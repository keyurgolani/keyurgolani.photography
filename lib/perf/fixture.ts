import { createHash } from 'node:crypto';
import { buildTestCatalog, type TestCatalogContent, type TestCatalogOptions, type TestPhotoSpec, type TestSeriesSpec, type VariantByteTable } from '../catalog/testing';

/**
 * #6's large fixture library: 5,000 photographs across 100 series, built by
 * #13's test catalog with declared variant sizes, so no image data exists or
 * goes into Git. Test-only; nothing in the app imports it.
 *
 * Its shape is #6's refined fixture on today's 100-record pages. Work order
 * leads with the fixed series: the featured one of 100, first in
 * `featuredSeriesIds`; one of 1,200; three of 300; 99, 101, 199, 200 and 201,
 * the edges of one and two pages; and a single photograph. The other 89
 * split the rest, 22 or 23 each. A tenth of the photographs and of the series
 * carry copy at length (LONG_COPY), 2% of photographs are decorative, about
 * 30% are portrait, about 3% are 3:1 panoramas, 5% are shown whole
 * (`crop: 'contain'`), and a fifth have an off-center focal point.
 *
 * Every photograph's record comes from the seed, its series and its position
 * there, and every series record from the seed and its index, never from the
 * photo count. So `{ photos: 500 }` keeps the 100 series, their copy and
 * covers, and the featured 100, and shrinks the rest, which is what the scale
 * test compares. The long series shrinks to 98 there, so it has no photograph
 * 600, and the Viewer's real-length figure goes with it. Three things are held still for e2e/first-viewport.spec.ts,
 * which sizes the first viewport on this library: no cover is a panorama or
 * shown whole, the featured series holds no panorama, and its first two
 * photographs, Home's eager pair and the Viewer's lead there, are plain 3:2
 * landscapes with short copy.
 */

/** The library's photographs. */
export const BUDGET_PHOTOS = 5_000;
/** The featured series: exactly one 100-record page, and Home's ID list. */
export const FEATURED_PHOTOS = 100;
/** The long series: twelve pages, and the Viewer's real-length photograph. */
export const LONG_SERIES_PHOTOS = 1_200;
/** The fixed series at 5,000 photographs, first in Work order. */
export const FIXED_SERIES_PHOTOS = [FEATURED_PHOTOS, LONG_SERIES_PHOTOS, 300, 300, 300, 99, 101, 199, 200, 201, 1] as const;
const SERIES_COUNT = 100;
/** The index of the long series in Work order, and of the series --variant b drops a photograph from. */
const LONG_SERIES = 1;
const EDGE_SERIES = FIXED_SERIES_PHOTOS.indexOf(101);
/** The long series' photograph that always carries long copy: the middle one, where the browser budgets open the Viewer. */
export const REAL_LENGTH_POSITION = 600;
/** The featured series' two photographs shown whole. */
const FEATURED_CONTAIN = [12, 61];

/** Character counts for copy at length, from #6's refined fixture. A photograph's title is 80, its series' title too. */
export const LONG_COPY = { alt: 250, caption: 600, title: 80, seriesTitle: 80, statement: 1_200, shortStatement: 300 } as const;

const KIB = 1024;

/** Declared AVIF and WebP sizes per rung, in bytes, from #6's refined fixture table. Screens don't ship them (see ladder.ts). */
export const BUDGET_VARIANT_BYTES: VariantByteTable = {
    w400: { avif: 30 * KIB, webp: 42 * KIB },
    w800: { avif: 90 * KIB, webp: 126 * KIB },
    w1200: { avif: 170 * KIB, webp: 238 * KIB },
    w1920: { avif: 350 * KIB, webp: 490 * KIB },
};

export interface BudgetFixtureOptions {
    /** At least 199: the featured 100 and one each for the other 99 series. Defaults to 5,000. */
    photos?: number;
    /** `b` reorders the long series after its cover and drops the 101-photograph series' last photograph. */
    variant?: 'a' | 'b';
    seed?: number;
}

/** Series sizes in Work order for `photos` photographs: the featured 100, then the 5,000-photograph shape scaled to the rest, each at least 1. */
export function seriesSizes(photos: number = BUDGET_PHOTOS): number[] {
    if (!Number.isInteger(photos) || photos < FEATURED_PHOTOS + SERIES_COUNT - 1) throw new RangeError(`The budget fixture needs at least ${FEATURED_PHOTOS + SERIES_COUNT - 1} photographs, got ${photos}.`);
    const rest = BUDGET_PHOTOS - FIXED_SERIES_PHOTOS.reduce((sum, size) => sum + size, 0);
    const open = SERIES_COUNT - FIXED_SERIES_PHOTOS.length;
    const basis = [...FIXED_SERIES_PHOTOS.slice(1), ...Array.from({ length: open }, (_, index) => Math.floor(rest / open) + (index < rest % open ? 1 : 0))];
    // Largest remainder, so the others add up to exactly what's left, and none goes under 1.
    const total = basis.reduce((sum, size) => sum + size, 0);
    const left = photos - FEATURED_PHOTOS;
    const shares = basis.map((size) => (size * left) / total);
    const sizes = shares.map((share) => Math.max(1, Math.floor(share)));
    let gap = left - sizes.reduce((sum, size) => sum + size, 0);
    const byRemainder = shares.map((share, index) => ({ index, remainder: share - Math.floor(share) })).sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    for (let at = 0; gap > 0; at = (at + 1) % byRemainder.length, gap -= 1) sizes[byRemainder[at].index] += 1;
    for (let index = sizes.length - 1; gap < 0; index = (index - 1 + sizes.length) % sizes.length) {
        if (sizes[index] > 1) {
            sizes[index] -= 1;
            gap += 1;
        }
    }
    return [FEATURED_PHOTOS, ...sizes];
}

/** mulberry32, from a seed derived from `parts`, so a record depends only on what names it. */
function randomFor(...parts: (string | number)[]): () => number {
    let state = createHash('sha256').update(parts.join(':')).digest().readUInt32LE(0);
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function photoIdFrom(random: () => number): string {
    const bytes = Array.from({ length: 16 }, () => Math.floor(random() * 256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `ph_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const CONSONANTS = 'bcdfghklmnprstvz';
const VOWELS = 'aeiou';

/**
 * Seeded prose of exactly `length` characters: syllables in words, with a
 * full stop now and then. Random syllables gzip worse than real prose, so
 * the copy errs high. Not every number does: each record carries the test
 * catalog's 10 px placeholder LQIP, smaller than a real one, so a model that
 * ships one (Home's opening, a series cover) errs low by that much. No
 * digits, so no camera token.
 */
function prose(random: () => number, length: number): string {
    const pick = (from: string) => from[Math.floor(random() * from.length)];
    let text = '';
    while (text.length < length + 1) {
        const word = Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(CONSONANTS) + pick(VOWELS)).join('');
        text += `${text.length === 0 || text.endsWith('. ') ? word[0].toUpperCase() + word.slice(1) : word}${random() < 0.12 ? '. ' : ' '}`;
    }
    return `${text.slice(0, length - 1).trimEnd().padEnd(length - 1, 'a')}.`;
}

const LANDSCAPE = { width: 2400, height: 1600 };
const PORTRAIT = { width: 1600, height: 2400 };
const PANORAMA = { width: 3600, height: 1200 };

function photoSpec(seed: number, series: number, position: number, longSeriesMiddle: boolean): TestPhotoSpec {
    const random = randomFor('budget-photo', seed, series, position);
    const id = photoIdFrom(random);
    const name = `${String(series + 1).padStart(2, '0')}-${String(position + 1).padStart(4, '0')}`;
    const featured = series === 0;
    const plain = featured && position < 2;
    const [shape, crop, focal, decorative, long] = [random(), random(), random(), random(), random()];
    let size = shape < 0.3 ? PORTRAIT : shape < 0.33 ? PANORAMA : LANDSCAPE;
    // A cover is never a panorama or shown whole; its shape alternates by series, as the default fixture's did.
    if (position === 0) size = series % 2 === 0 ? LANDSCAPE : PORTRAIT;
    if (featured && size === PANORAMA) size = LANDSCAPE;
    if (plain) size = LANDSCAPE;
    const spec: TestPhotoSpec = { id, ...size };
    const contain = featured ? FEATURED_CONTAIN.includes(position) : position > 0 && crop < 0.05;
    if (contain) spec.crop = 'contain';
    if (!plain && focal < 0.2) spec.focalPoint = { x: Math.round((0.15 + random() * 0.7) * 100) / 100, y: Math.round((0.15 + random() * 0.7) * 100) / 100 };
    if (!plain && !longSeriesMiddle && position > 0 && decorative < 0.02) {
        spec.alt = { kind: 'decorative' };
    } else if (!plain && (long < 0.1 || longSeriesMiddle)) {
        spec.alt = { kind: 'described', text: prose(random, LONG_COPY.alt), reviewed: true };
        spec.caption = prose(random, LONG_COPY.caption);
        spec.title = prose(random, LONG_COPY.title);
    } else {
        spec.alt = { kind: 'described', text: `Fixture description of photograph ${name}.`, reviewed: true };
    }
    return spec;
}

function seriesCopy(seed: number, series: number): Pick<TestSeriesSpec, 'title' | 'statement' | 'shortStatement'> {
    const random = randomFor('budget-series', seed, series);
    if (random() >= 0.1) return {};
    return { title: prose(random, LONG_COPY.seriesTitle), statement: prose(random, LONG_COPY.statement), shortStatement: prose(random, LONG_COPY.shortStatement) };
}

/** createTestCatalog() and buildTestCatalog() options for the budget library, with `--photos`, `--variant` and `--seed`. */
export function budgetFixtureOptions({ photos = BUDGET_PHOTOS, variant = 'a', seed = 6 }: BudgetFixtureOptions = {}): TestCatalogOptions {
    const sizes = seriesSizes(photos);
    const photoSpecs: TestPhotoSpec[] = [];
    const series: TestSeriesSpec[] = sizes.map((count, index) => {
        const members = Array.from({ length: count }, (_, position) => photoSpec(seed, index, position, index === LONG_SERIES && position === REAL_LENGTH_POSITION));
        photoSpecs.push(...members);
        let photoIds = members.map((member) => member.id as string);
        if (variant === 'b' && index === LONG_SERIES) photoIds = [photoIds[0], ...photoIds.slice(1).reverse()];
        if (variant === 'b' && index === EDGE_SERIES) photoIds = photoIds.slice(0, -1);
        return { ...seriesCopy(seed, index), photoIds, cover: { photoId: members[0].id as string } };
    });
    return { photos: photoSpecs, series, seed, variantBytes: BUDGET_VARIANT_BYTES };
}

/** The 5,000-photograph library, variant a. */
export const BUDGET_FIXTURE: TestCatalogOptions = budgetFixtureOptions();

/**
 * The fixture's content and reader, in memory, for the Vitest budgets.
 * `createTestCatalog(budgetFixtureOptions(options))` writes the same catalog
 * to a data root, manifests and sparse variant files included, for a browser
 * run; at 5,000 photographs that's about 45,000 files and takes minutes on a
 * loaded machine.
 */
export function buildBudgetFixture(options?: BudgetFixtureOptions): Promise<TestCatalogContent> {
    return buildTestCatalog(options ? budgetFixtureOptions(options) : BUDGET_FIXTURE);
}
