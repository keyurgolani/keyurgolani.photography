import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '@/lib/identity/variants';
import { mediaUrl } from '@/lib/media/url';
import type { WorkCatalog, WorkCover, WorkSeriesSummary } from '@/lib/catalog/projections/work';
import SeriesCatalog, { WORK_TITLE } from '../SeriesCatalog';
import WorkCoverImage from '../WorkCoverImage';
import { coverSizes, coverSpan } from '../coverSizes';
import { preloadsIn, serverHtml } from '@/test/helpers/serverHtml';

const REF = (n: number) => ({ photoId: `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, assetRevision: `sha256-${String(n % 10).repeat(64)}`, profileId: 'p_0123456789abcdef' });

function cover(n: number, overrides: Partial<WorkCover> = {}): WorkCover {
    const ref = REF(n);
    const variants = {} as WorkCover['variants'];
    for (const width of VARIANT_WIDTHS) {
        variants[width] = {} as WorkCover['variants'][typeof width];
        for (const format of VARIANT_FORMATS) {
            const pixels = Number(width.slice(1));
            variants[width][format] = { url: mediaUrl(ref, width, format), width: pixels };
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
        expect(screen.getByText('No series are published right now.')).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(WORK_TITLE);
        // The heading and the one line: no placeholder, skeleton, or cover.
        expect(document.querySelectorAll('img, [data-cover]')).toHaveLength(0);
        expect([...screen.getByRole('main').querySelectorAll('h1, p')].map((el) => el.textContent)).toEqual([WORK_TITLE, 'No series are published right now.']);
    });

    it('loads the first two covers at once, only the first at high priority and preloaded, and the rest lazily (#3)', () => {
        const entries = work([series(1), series(2), series(3), series(4)]);
        render(<SeriesCatalog work={entries} />);
        const images = [...document.querySelectorAll('img')];
        expect(images.map((image) => image.getAttribute('loading'))).toEqual(['eager', 'eager', 'lazy', 'lazy']);
        // The second at low priority, so the lead has the link to itself first on a slow phone (#172's LCP bar).
        expect(images.map((image) => image.getAttribute('fetchpriority'))).toEqual(['high', 'low', null, null]);
        const links = preloadsIn(serverHtml(<SeriesCatalog work={entries} />));
        expect(links).toHaveLength(1);
        expect(links[0].getAttribute('imagesrcset')).toContain(REF(1).photoId);
    });

    it('renders a series with no cover text-led, with its link intact and no image', () => {
        render(<SeriesCatalog work={work([series(1, { cover: null }), series(2)])} />);
        const [first, second] = screen.getAllByRole('link');
        expect(first).toHaveAttribute('href', '/work/entry-1');
        expect(first.querySelector('img')).toBeNull();
        expect(first.querySelector('[data-cover="unavailable"]')).not.toBeNull();
        expect(second.querySelector('img')).not.toBeNull();
    });

    it('passes the client cover component only the projection cover, the loading flag, and its span', async () => {
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
            ['cover', 'loading', 'span'],
            ['cover', 'loading', 'span'],
        ]);
        expect(Object.keys(seen[0].cover as object).sort()).toEqual(['crop', 'focalPoint', 'height', 'photoId', 'variants', 'width']);
        expect(seen[1].cover).toBeNull();
    });

    // The stylesheet's 768 px grid: the 1st and 4th of every four entries span 7 of 12 columns, the 2nd and 3rd span 5.
    it('gives each cover the sizes of its own span and its own crop, wide for the 1st and 4th of every four, narrow for the 2nd and 3rd', () => {
        expect([0, 1, 2, 3, 4, 5, 6, 7].map(coverSpan)).toEqual(['wide', 'narrow', 'narrow', 'wide', 'wide', 'narrow', 'narrow', 'wide']);
        const entries = [
            series(1),
            series(2, { cover: cover(2, { width: 1600, height: 2400 }) }),
            series(3, { cover: cover(3, { width: 1600, height: 2400, crop: 'contain' }) }),
            series(4, { cover: cover(4, { width: 3000, height: 1000 }) }),
            series(5),
        ];
        render(<SeriesCatalog work={work(entries)} />);
        const sizes = [...document.querySelectorAll('picture')].map((picture) => picture.querySelector('source')?.getAttribute('sizes'));
        expect(sizes).toEqual(entries.map((entry, index) => coverSizes(entry.cover!, coverSpan(index))));
        expect(new Set(sizes).size, 'each shape, crop and span its own').toBe(4);
    });

    it('drops a failed cover\'s fallback when a refresh brings the series a new cover, and keeps it for the same one', () => {
        const { rerender } = render(<SeriesCatalog work={work([series(1)])} />);
        act(() => {
            fireEvent.error(document.querySelector('img') as HTMLImageElement);
        });
        expect(document.querySelector('[data-cover="unavailable"]')).not.toBeNull();
        rerender(<SeriesCatalog work={work([series(1)])} />);
        expect(document.querySelector('img')).toBeNull();
        rerender(<SeriesCatalog work={work([series(1, { cover: cover(5) })])} />);
        expect(document.querySelector('[data-cover="unavailable"]')).toBeNull();
        expect(document.querySelector('img')?.getAttribute('src')).toBe(cover(5).variants.w1200.webp.url);
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
        for (const source of container.querySelectorAll('source')) expect(source).toHaveAttribute('sizes', coverSizes(cover(4), 'wide'));
        const frame = container.firstElementChild as HTMLElement;
        expect(frame.style.getPropertyValue('--focal-x')).toBe('25%');
        expect(frame.style.getPropertyValue('--focal-y')).toBe('75%');
        expect(frame).toHaveAttribute('data-cover', 'cover');
    });

    it('marks a contain crop for the stylesheet', () => {
        const { container } = render(<WorkCoverImage cover={cover(4, { crop: 'contain' })} loading="lead" />);
        expect(container.firstElementChild).toHaveAttribute('data-cover', 'contain');
        expect(container.querySelector('img')).toHaveAttribute('loading', 'eager');
    });

    it('preloads only the first cover, at high priority, with the srcset and sizes its <picture> has (#6)', () => {
        const lazy = render(<WorkCoverImage cover={cover(6)} />).container;
        expect(lazy.querySelector('img')?.hasAttribute('fetchpriority')).toBe(false);
        expect(preloadsIn(serverHtml(<WorkCoverImage cover={cover(6)} />))).toHaveLength(0);
        const eager = render(<WorkCoverImage cover={cover(7)} loading="lead" />).container;
        expect(eager.querySelector('img')).toHaveAttribute('fetchpriority', 'high');
        const links = preloadsIn(serverHtml(<WorkCoverImage cover={cover(7)} loading="lead" />));
        expect(links).toHaveLength(1);
        expect(links[0].getAttribute('imagesrcset')).toBe(eager.querySelector('source[type="image/avif"]')?.getAttribute('srcset'));
        expect(links[0].getAttribute('imagesizes')).toBe(coverSizes(cover(7), 'wide'));
    });

    it('sizes a narrow cover for its 5 of 12 columns, and never asks a phone for less than its width', () => {
        const { container } = render(<WorkCoverImage cover={cover(8)} span="narrow" />);
        for (const source of container.querySelectorAll('source')) expect(source).toHaveAttribute('sizes', coverSizes(cover(8), 'narrow'));
    });

    // #6's size rule, per crop: a cover crop asks for the wider of the box and the photograph at the box's height, a
    // contain one for the narrower. Boxes: 7 or 5 of the 12 columns at 3:2 or 4:5 above 768 px, less their share of the
    // column gaps, and the column at 4:3 below, the column being the window less its two gutters (2rem under 485 px,
    // 6.6vw over it). Under 768 px Work then takes the one rung smaller the rule allows (rule 5): two thirds of what
    // the box needs, under the next rung down but never two, since each rung is at least 1.5 times the one before.
    it('sizes each cover by its crop and its box, a rung under the rule\'s only under 768 px (#6)', () => {
        // A 3:2 photograph fills a wide 3:2 box exactly, and is 1.125 times a phone's 4:3 box wide.
        expect(coverSizes(cover(1), 'wide')).toBe('(min-width: 768px) calc(53.44vw - 0.63rem), (min-width: 485px) 70.05vw, calc(75vw - 1.5rem)');
        // In a narrow 4:5 box it's 1.875 boxes wide, so it asks for more than the box.
        expect(coverSizes(cover(1), 'narrow')).toBe('(min-width: 768px) calc(70.23vw - 1.64rem), (min-width: 485px) 70.05vw, calc(75vw - 1.5rem)');
        // A 2:3 photograph shown whole sits at the box's height: five sixths of the 4:5 box, half the 4:3 one.
        expect(coverSizes(cover(1, { width: 1600, height: 2400, crop: 'contain' }), 'narrow')).toBe(
            '(min-width: 768px) calc(31.22vw - 0.73rem), (min-width: 485px) 31.13vw, calc(33.33vw - 0.67rem)',
        );
        // A 2:3 photograph cropped to cover is cut to the box's width.
        expect(coverSizes(cover(1, { width: 1600, height: 2400 }), 'wide')).toBe('(min-width: 768px) calc(53.44vw - 0.63rem), (min-width: 485px) 62.27vw, calc(66.67vw - 1.33rem)');
    });

    // The rung-down pays for 3x phones (#172's LCP bar). On a 1x desktop a cover asks for at least its box's own width,
    // so a 2:3 cover in a 542 px box never comes from the 400 px file.
    it('asks a desktop-width cover crop for at least its box\'s width, whatever its shape and span', () => {
        for (const span of ['wide', 'narrow'] as const) {
            for (const shape of [{ width: 2400, height: 1600 }, { width: 1600, height: 2400 }, { width: 3000, height: 1000 }]) {
                const desktop = coverSizes(cover(1, shape), span).split(', ')[0];
                const box = span === 'wide' ? 'calc(53.44vw - 0.63rem)' : 'calc(37.46vw - 0.88rem)';
                const [vw, rem] = (/calc\(([\d.]+)vw - ([\d.]+)rem\)/.exec(desktop) ?? []).slice(1).map(Number);
                const [boxVw, boxRem] = (/calc\(([\d.]+)vw - ([\d.]+)rem\)/.exec(box) ?? []).slice(1).map(Number);
                expect(vw, `${span} ${shape.width}x${shape.height}: ${desktop}`).toBeGreaterThanOrEqual(boxVw);
                // The same box scaled up, not shrunk somewhere else: its vw and rem keep their proportions, to rounding.
                expect(Math.abs(vw / rem / (boxVw / boxRem) - 1), `${span} ${shape.width}x${shape.height}: the box's own proportions`).toBeLessThan(0.02);
            }
        }
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
