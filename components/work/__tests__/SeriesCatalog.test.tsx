import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '@/lib/identity/variants';
import { mediaUrl } from '@/lib/media/url';
import type { WorkCatalog, WorkCover, WorkSeriesSummary } from '@/lib/catalog/projections/work';
import SeriesCatalog, { WORK_TITLE } from '../SeriesCatalog';
import WorkCoverImage, { COVER_SIZES } from '../WorkCoverImage';

const REF = (n: number) => ({ photoId: `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, assetRevision: `sha256-${String(n % 10).repeat(64)}`, profileId: 'p_0123456789abcdef' });

function cover(n: number, overrides: Partial<WorkCover> = {}): WorkCover {
    const ref = REF(n);
    const variants = {} as WorkCover['variants'];
    for (const width of VARIANT_WIDTHS) {
        variants[width] = {} as WorkCover['variants'][typeof width];
        for (const format of VARIANT_FORMATS) {
            const pixels = Number(width.slice(1));
            variants[width][format] = { url: mediaUrl(ref, width, format), width: pixels, height: Math.round((pixels * 2) / 3), bytes: 1_000 };
        }
    }
    return { photoId: ref.photoId, width: 2400, height: 1600, variants, focalPoint: { x: 0.25, y: 0.75 }, crop: 'cover', ...overrides };
}

function series(n: number, overrides: Partial<WorkSeriesSummary> = {}): WorkSeriesSummary {
    return {
        id: `ser_entry-${n}`,
        slug: `entry-${n}`,
        href: `/work/entry-${n}`,
        title: `Entry ${n}`,
        shortStatement: `Short statement ${n}.`,
        derived: { photoCount: n },
        cover: cover(n),
        ...overrides,
    };
}

const work = (entries: WorkSeriesSummary[]): WorkCatalog => ({ catalogRevision: `rev_${'a'.repeat(64)}`, series: entries });

/** Stubs the image state the mount check reads, for every img rendered after it. */
function imageState({ complete, naturalWidth, currentSrc }: { complete: boolean; naturalWidth: number; currentSrc: string }) {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(complete);
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(naturalWidth);
    vi.spyOn(HTMLImageElement.prototype, 'currentSrc', 'get').mockReturnValue(currentSrc);
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('SeriesCatalog', () => {
    it('gives the page one h1, the reference treatment\'s Work title', () => {
        render(<SeriesCatalog work={work([series(1)])} />);
        expect(screen.getAllByRole('heading', { level: 1 }).map((heading) => heading.textContent)).toEqual([WORK_TITLE]);
        expect(WORK_TITLE).toBe('Bodies of work');
        expect(screen.getByRole('main')).toContainElement(screen.getByRole('heading', { level: 1 }));
    });

    it('renders one list item and one link per series, in the order it gets, each to its href', () => {
        const entries = [series(3), series(1), series(2)];
        render(<SeriesCatalog work={work(entries)} />);
        const items = within(screen.getByRole('list')).getAllByRole('listitem');
        expect(items).toHaveLength(3);
        for (const [index, item] of items.entries()) {
            const links = within(item).getAllByRole('link');
            expect(links).toHaveLength(1);
            expect(links[0]).toHaveAttribute('href', entries[index].href);
        }
        expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['Entry 3', 'Entry 1', 'Entry 2']);
    });

    it('names each link by its visible text, title first, so every name is unique and starts with the label', () => {
        render(<SeriesCatalog work={work([series(1), series(2)])} />);
        const names = screen.getAllByRole('link').map((link) => link.textContent);
        expect(names).toEqual(['Entry 1Short statement 1.1 photograph', 'Entry 2Short statement 2.2 photographs']);
    });

    it('keeps the derived count in its own element, apart from the authored title and statement', () => {
        render(<SeriesCatalog work={work([series(7)])} />);
        const link = screen.getByRole('link');
        const count = within(link).getByText('7 photographs');
        const title = within(link).getByRole('heading', { level: 2 });
        const statement = within(link).getByText('Short statement 7.');
        expect(count.tagName).toBe('P');
        expect(count.className).not.toBe(statement.className);
        expect(count).not.toContainElement(title);
        expect(statement).not.toContainElement(count);
    });

    it('leaves the statement out when it is null, and keeps the title and count', () => {
        render(<SeriesCatalog work={work([series(1, { shortStatement: null })])} />);
        const link = screen.getByRole('link');
        expect(link.querySelectorAll('p')).toHaveLength(1);
        expect(link).toHaveTextContent('Entry 11 photograph');
    });

    it('shows the empty state with no list and no links when nothing is published', () => {
        render(<SeriesCatalog work={work([])} />);
        expect(screen.queryByRole('list')).toBeNull();
        expect(screen.queryByRole('link')).toBeNull();
        expect(screen.getByText('No series are published yet.')).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(WORK_TITLE);
    });

    it('loads the first cover at once and the rest lazily', () => {
        render(<SeriesCatalog work={work([series(1), series(2), series(3)])} />);
        const images = [...document.querySelectorAll('img')];
        expect(images.map((image) => image.getAttribute('loading'))).toEqual(['eager', 'lazy', 'lazy']);
    });

    it('renders a series with no cover text-led, with its link intact and no image', () => {
        render(<SeriesCatalog work={work([series(1, { cover: null }), series(2)])} />);
        const [first, second] = screen.getAllByRole('link');
        expect(first).toHaveAttribute('href', '/work/entry-1');
        expect(first.querySelector('img')).toBeNull();
        expect(first.querySelector('[data-cover="unavailable"]')).not.toBeNull();
        expect(second.querySelector('img')).not.toBeNull();
    });

    it('passes the client cover component only the projection cover and the loading flag', async () => {
        vi.resetModules();
        const seen: Record<string, unknown>[] = [];
        vi.doMock('../WorkCoverImage', () => ({
            default: (props: Record<string, unknown>) => {
                seen.push(props);
                return null;
            },
        }));
        const { default: Catalog } = await import('../SeriesCatalog');
        render(<Catalog work={work([series(1), series(2, { cover: null })])} />);
        vi.doUnmock('../WorkCoverImage');
        expect(seen.map((props) => Object.keys(props).sort())).toEqual([
            ['cover', 'eager'],
            ['cover', 'eager'],
        ]);
        expect(Object.keys(seen[0].cover as object).sort()).toEqual(['crop', 'focalPoint', 'height', 'photoId', 'variants', 'width']);
        expect(seen[1].cover).toBeNull();
    });
});

describe('WorkCoverImage', () => {
    it('renders the cover from /media with an empty alt, the cover sizes, and its focal point', () => {
        const { container } = render(<WorkCoverImage cover={cover(4)} />);
        const image = container.querySelector('img');
        expect(image).toHaveAttribute('alt', '');
        expect(image).toHaveAttribute('src', mediaUrl(REF(4), 'w1200', 'webp'));
        expect(image).toHaveAttribute('width', '2400');
        expect(image).toHaveAttribute('height', '1600');
        expect(image).toHaveAttribute('loading', 'lazy');
        for (const source of container.querySelectorAll('source')) expect(source).toHaveAttribute('sizes', COVER_SIZES);
        const frame = container.firstElementChild as HTMLElement;
        expect(frame.style.getPropertyValue('--focal-x')).toBe('25%');
        expect(frame.style.getPropertyValue('--focal-y')).toBe('75%');
        expect(frame).toHaveAttribute('data-cover', 'cover');
    });

    it('marks a contain crop for the stylesheet', () => {
        const { container } = render(<WorkCoverImage cover={cover(4, { crop: 'contain' })} eager />);
        expect(container.firstElementChild).toHaveAttribute('data-cover', 'contain');
        expect(container.querySelector('img')).toHaveAttribute('loading', 'eager');
    });

    it('swaps in the text fallback when the image fails, never leaving a broken image', () => {
        const { container } = render(<WorkCoverImage cover={cover(4)} />);
        const image = container.querySelector('img') as HTMLImageElement;
        act(() => {
            fireEvent.error(image);
        });
        expect(container.querySelector('img')).toBeNull();
        expect(container.querySelector('picture')).toBeNull();
        const fallback = container.querySelector('[data-cover="unavailable"]');
        expect(fallback).toHaveTextContent('Cover unavailable');
        expect(fallback?.querySelector('[aria-hidden="true"]')).toHaveTextContent('Cover unavailable');
    });

    it('swaps in the fallback at mount for an image that failed before hydration', () => {
        imageState({ complete: true, naturalWidth: 0, currentSrc: 'http://localhost/media/x/w1200.webp' });
        const { container } = render(<WorkCoverImage cover={cover(4)} />);
        expect(container.querySelector('img')).toBeNull();
        expect(container.querySelector('[data-cover="unavailable"]')).not.toBeNull();
    });

    it.each([
        ['a lazy image that has not started', { complete: true, naturalWidth: 0, currentSrc: '' }],
        ['an image still loading', { complete: false, naturalWidth: 0, currentSrc: 'http://localhost/media/x/w1200.webp' }],
        ['an image that loaded', { complete: true, naturalWidth: 1200, currentSrc: 'http://localhost/media/x/w1200.webp' }],
    ])('keeps %s', (_, stateOfImage) => {
        imageState(stateOfImage);
        const { container } = render(<WorkCoverImage cover={cover(4)} />);
        expect(container.querySelector('img')).not.toBeNull();
        expect(container.querySelector('[data-cover="unavailable"]')).toBeNull();
    });

    it('renders the same fallback box for a null cover', () => {
        const { container } = render(<WorkCoverImage cover={null} />);
        expect(container.querySelector('img')).toBeNull();
        expect(container.querySelector('[data-cover="unavailable"]')).toHaveTextContent('Cover unavailable');
    });
});
