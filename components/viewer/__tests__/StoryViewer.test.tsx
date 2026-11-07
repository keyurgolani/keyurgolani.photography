import { act, fireEvent, isInaccessible, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '@/lib/identity/variants';
import { mediaUrl } from '@/lib/media/url';
import type { PublishedViewerPhoto, ViewerImage } from '@/lib/catalog/projections/viewer';
import StoryViewer, { type StoryViewerProps } from '../StoryViewer';
import { fitSizes } from '../viewerSizes';
import { preloadsIn, serverHtml } from '@/test/helpers/serverHtml';
import { FAILED_LABEL, HIDE_TECHNICAL, RETRY_LABEL, SHOW_TECHNICAL, TECHNICAL_SOURCE, UNAVAILABLE_LABEL, accentValue, positionLabel, positionText, technicalFacts, viewerTitle } from '../viewerLabels';

// The props Link gets, as attributes, so a test can see a move replaces the history entry and nothing prefetches.
vi.mock('next/link', () => ({
    default: ({ href, replace, prefetch, children, ...rest }: { href: string; replace?: boolean; prefetch?: boolean | null; children: ReactNode }) => (
        <a href={href} data-replace={String(Boolean(replace))} data-prefetch={String(prefetch)} {...rest}>
            {children}
        </a>
    ),
}));

const PHOTO_ID = 'ph_00000000-0000-4000-8000-000000000003';
const REF = { photoId: PHOTO_ID, assetRevision: `sha256-${'3'.repeat(64)}`, profileId: 'p_0123456789abcdef' };

function variants(): ViewerImage['variants'] {
    const ladder = {} as ViewerImage['variants'];
    for (const width of VARIANT_WIDTHS) {
        ladder[width] = {} as (typeof ladder)[typeof width];
        for (const format of VARIANT_FORMATS) {
            const pixels = Number(width.slice(1));
            ladder[width][format] = { url: mediaUrl(REF, width, format), width: pixels };
        }
    }
    return ladder;
}

function model(photo: Partial<PublishedViewerPhoto['photo']> = {}, rest: Partial<PublishedViewerPhoto> = {}): PublishedViewerPhoto {
    return {
        catalogRevision: `rev_${'a'.repeat(64)}`,
        series: { id: 'ser_fixture', slug: 'fixture', title: 'Fixture series', accent: '#a0b0c0' },
        photo: {
            id: PHOTO_ID,
            title: 'Fixture title',
            description: 'A fixture description of the visible scene.',
            caption: 'An authored fixture caption.',
            alt: 'A fixture description of the visible scene.',
            descriptionPending: false,
            namedByPlace: false,
            image: { width: 2400, height: 1600, assetRevision: REF.assetRevision, variants: variants() },
            shareImage: { url: mediaUrl(REF, 'w1200', 'webp'), width: 1200, height: 800 },
            accent: '#c08040',
            technical: { Make: 'Fixture Make', Model: 'Fixture Model', FNumber: '2.8', ISO: '200' },
            ...photo,
        },
        position: 3,
        total: 12,
        previousPhotoId: 'ph_00000000-0000-4000-8000-000000000002',
        nextPhotoId: 'ph_00000000-0000-4000-8000-000000000004',
        ...rest,
    };
}

function renderViewer(props: Partial<StoryViewerProps> = {}) {
    return render(
        <StoryViewer
            viewer={model()}
            closeHref="/work/fixture"
            previousHref="/work/fixture/photo/ph_00000000-0000-4000-8000-000000000002"
            nextHref="/work/fixture/photo/ph_00000000-0000-4000-8000-000000000004"
            pendingCopy={null}
            {...props}
        />,
    );
}

describe('StoryViewer', () => {
    it('names the series and the position in the header, with Close back to the series and Zoom', () => {
        const { container } = renderViewer();
        const header = container.querySelector('header');
        if (!header) throw new Error('No header');
        // The heading says the series and the place in it (#7): "{series title}, photograph 3 of 12".
        expect(within(header).getByRole('heading', { level: 1 })).toHaveAccessibleName('Fixture series, photograph 3 of 12');
        expect(header).toHaveTextContent('03 / 12');
        // The padded form is for the eye; a screen reader reads the heading's spelled-out position instead.
        expect(within(header).getByText('03 / 12')).toHaveAttribute('aria-hidden', 'true');
        expect(isInaccessible(within(header).getByText('03 / 12'))).toBe(true);
        expect(within(header).getByRole('link', { name: 'Close' })).toHaveAttribute('href', '/work/fixture');
        expect(within(header).getByRole('button', { name: 'Zoom' })).toHaveAttribute('aria-pressed', 'false');
        // The Viewer is its own surface, with no SiteNav.
        expect(container.querySelectorAll('[data-surface="viewer"]')).toHaveLength(1);
        expect(screen.queryByRole('navigation')).toBeNull();
    });

    it('shows the photograph from its /media set, with its own size and alt, never an optimizer or original URL', () => {
        const { container } = renderViewer();
        const image = screen.getByRole('img', { name: 'A fixture description of the visible scene.' });
        expect(image).toHaveAttribute('src', mediaUrl(REF, 'w1200', 'webp'));
        expect([image.getAttribute('width'), image.getAttribute('height')]).toEqual(['2400', '1600']);
        // The photograph is the page's largest paint, so it loads at once and first.
        expect([image.getAttribute('loading'), image.getAttribute('fetchpriority')]).toEqual(['eager', 'high']);
        expect(container.querySelector('source[type="image/avif"]')).toHaveAttribute('sizes', fitSizes(2400, 1600));
        const urls = [...container.querySelectorAll('img, source')].flatMap((element) => [element.getAttribute('src'), element.getAttribute('srcset')]).filter(Boolean).join(' ');
        expect(urls).not.toMatch(/_next\/image|api\/image/);
        for (const url of urls.split(/[\s,]+/).filter((part) => part.startsWith('/'))) expect(url).toMatch(/^\/media\//);
    });

    it('moves inside the series with links that replace the history entry and stop at the ends', () => {
        const { unmount } = renderViewer();
        expect(screen.getByRole('link', { name: 'Previous photograph' })).toHaveAttribute('href', '/work/fixture/photo/ph_00000000-0000-4000-8000-000000000002');
        expect(screen.getByRole('link', { name: 'Next photograph' })).toHaveAttribute('href', '/work/fixture/photo/ph_00000000-0000-4000-8000-000000000004');
        // A move replaces the history entry, so one Back leaves the Viewer. Nothing prefetches a revision that may not be active later.
        for (const name of ['Previous photograph', 'Next photograph']) {
            expect(screen.getByRole('link', { name })).toHaveAttribute('data-replace', 'true');
            expect(screen.getByRole('link', { name })).toHaveAttribute('data-prefetch', 'false');
        }
        expect(screen.getByRole('link', { name: 'Close' })).toHaveAttribute('data-replace', 'false');
        expect(screen.getByRole('link', { name: 'Close' })).toHaveAttribute('data-prefetch', 'false');
        unmount();

        const first = renderViewer({ previousHref: null });
        expect(screen.queryByRole('link', { name: 'Previous photograph' })).toBeNull();
        // An end stays a focusable button (#9): aria-disabled, never the disabled attribute, which drops focus.
        expect(screen.getByRole('button', { name: 'Previous photograph' })).toHaveAttribute('aria-disabled', 'true');
        expect(screen.getByRole('button', { name: 'Previous photograph' })).toBeEnabled();
        expect(screen.getByRole('link', { name: 'Next photograph' })).toBeInTheDocument();
        first.unmount();

        renderViewer({ nextHref: null });
        expect(screen.getByRole('button', { name: 'Next photograph' })).toHaveAttribute('aria-disabled', 'true');
        expect(screen.getByRole('button', { name: 'Next photograph' })).toBeEnabled();
        expect(screen.getByRole('link', { name: 'Previous photograph' })).toBeInTheDocument();
    });

    it('keeps authored copy apart from the camera facts, which start collapsed', () => {
        const { container } = renderViewer();
        const reading = screen.getByRole('region', { name: 'Fixture title' });
        expect(within(reading).getByRole('heading', { level: 2 })).toHaveTextContent('Fixture title');
        expect(within(reading).getByText('An authored fixture caption.')).toBeInTheDocument();
        // With a caption the reading area shows only the caption: the description is the image's alt (#7).
        expect(within(reading).queryByText('Description')).toBeNull();
        expect(within(reading).queryByText('A fixture description of the visible scene.')).toBeNull();
        const toggle = within(reading).getByRole('button', { name: SHOW_TECHNICAL });
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        const panel = container.querySelector(`#${CSS.escape(toggle.getAttribute('aria-controls') ?? '')}`);
        expect(panel).not.toBeNull();
        expect(panel).not.toBeVisible();
        expect(panel).toHaveTextContent(TECHNICAL_SOURCE);
        // Camera facts never stand in for authored copy.
        for (const fact of ['Fixture Model', 'f/2.8']) {
            expect(within(reading).getByText(fact).closest('[hidden]')).toBe(panel);
        }
    });

    it('shows and hides the technical details without moving focus off the toggle', () => {
        renderViewer();
        const toggle = screen.getByRole('button', { name: SHOW_TECHNICAL });
        toggle.focus();
        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expect(toggle).toHaveAccessibleName(HIDE_TECHNICAL);
        expect(document.activeElement).toBe(toggle);
        const facts = screen.getAllByRole('term')[0].closest('dl');
        expect(facts).toBeVisible();
        // One Camera row, with the make said once, and the aperture in its unit.
        expect([...(facts?.querySelectorAll('dt') ?? [])].map((term) => term.textContent)).toEqual(['Camera', 'Aperture', 'ISO']);
        expect([...(facts?.querySelectorAll('dd') ?? [])].map((value) => value.textContent)).toEqual(['Fixture Model', 'f/2.8', '200']);
        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(document.activeElement).toBe(toggle);
    });

    it('toggles Zoom as a pressed state, and the zoomed photograph sits in a scroll region the keyboard can reach', () => {
        const { container } = renderViewer();
        const zoom = screen.getByRole('button', { name: 'Zoom' });
        zoom.focus();
        fireEvent.click(zoom);
        expect(zoom).toHaveAttribute('aria-pressed', 'true');
        expect(document.activeElement).toBe(zoom);
        const region = screen.getByRole('region', { name: 'Zoomed photograph' });
        expect(region).toHaveAttribute('tabindex', '0');
        expect(container.querySelector('source[type="image/webp"]')).toHaveAttribute('sizes', '1920px');
        fireEvent.click(zoom);
        expect(zoom).toHaveAttribute('aria-pressed', 'false');
        expect(screen.queryByRole('region', { name: 'Zoomed photograph' })).toBeNull();
    });

    it('drops what the photo lacks: no title heading text, caption, description, or technical toggle', () => {
        renderViewer({ viewer: model({ title: null, caption: null, description: null, alt: '', technical: {} }) });
        const reading = screen.getByRole('region', { name: 'Photograph 3 of 12' });
        expect(within(reading).getByRole('heading', { level: 2 })).toHaveClass('sr-only');
        expect(within(reading).queryByText('Description')).toBeNull();
        expect(within(reading).queryByRole('button')).toBeNull();
        // A decorative photo's image has an empty alt.
        expect(document.querySelector('img')).toHaveAttribute('alt', '');
    });

    it('names a carried-over photograph by its place once, on the image: no sr-only heading, region name, or header position', () => {
        const { container } = renderViewer({ viewer: model({ title: null, caption: null, description: null, alt: 'Photograph 3 of 12', namedByPlace: true, technical: {} }) });
        expect(screen.queryAllByText('Photograph 3 of 12')).toEqual([]);
        expect(screen.getByRole('img', { name: 'Photograph 3 of 12' })).toBeInTheDocument();
        expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
        expect(screen.queryByRole('region', { name: 'Photograph 3 of 12' })).toBeNull();
        const header = container.querySelector('header')!;
        // The visible position stays, hidden from a screen reader, which hears the place on the image.
        expect(within(header).getByText('03 / 12')).toHaveAttribute('aria-hidden', 'true');
        expect(header.querySelector('.sr-only')).toBeNull();
        expect(within(header).getByRole('heading', { level: 1 })).toHaveAccessibleName('Fixture series');
        // The reading area keeps its title line, so the layout keeps its height.
        expect(container.querySelector('[data-viewer-reading] > div')).not.toBeNull();
    });

    it('keeps the heading and the header position for a titled photograph named by its place', () => {
        const { container } = renderViewer({ viewer: model({ title: 'Harbor at dawn', description: null, alt: 'Photograph 3 of 12', namedByPlace: true }) });
        expect(screen.getByRole('heading', { level: 2, name: 'Harbor at dawn' })).toBeInTheDocument();
        expect(within(container.querySelector('header')!).getByRole('heading', { level: 1 })).toHaveAccessibleName('Fixture series, photograph 3 of 12');
    });

    it('shows the pending copy only when the page passes it, in place of the description', () => {
        renderViewer({ viewer: model({ description: null, alt: '', descriptionPending: true }), pendingCopy: 'Description pending editorial review' });
        expect(screen.getByText('Description pending editorial review')).toHaveAttribute('data-description', 'pending');
    });

    it('reserves the box from the record\'s shape before the file arrives, and preloads the fitted rung (#6)', () => {
        const { container } = renderViewer();
        expect(container.querySelector('figure')?.getAttribute('style')).toContain('--ratio: 2400 / 1600');
        const props = { viewer: model(), closeHref: '/work/fixture', previousHref: null, nextHref: null, pendingCopy: null };
        const links = preloadsIn(serverHtml(<StoryViewer {...props} />));
        expect(links).toHaveLength(1);
        expect(links[0].getAttribute('imagesizes')).toBe(fitSizes(2400, 1600));
        expect(links[0].getAttribute('imagesrcset')).toBe(container.querySelector('source[type="image/avif"]')?.getAttribute('srcset'));
    });

    it('keeps the box, in the photograph\'s shape, with the moves and the reading area, when its file fails (#6)', () => {
        const { container, rerender } = renderViewer();
        fireEvent.error(screen.getByRole('img', { name: 'A fixture description of the visible scene.' }));
        const missing = container.querySelector('[data-photo="unavailable"]');
        // It says what happened, keeps the alt for everyone, and offers Retry (#7).
        expect(missing).toHaveTextContent(FAILED_LABEL);
        expect(FAILED_LABEL).toBe('This photograph could not be loaded.');
        expect(within(missing as HTMLElement).getByText(FAILED_LABEL).className).toMatch(/failedLabel/);
        expect(within(missing as HTMLElement).getByText('A fixture description of the visible scene.')).toBeInTheDocument();
        expect(within(missing as HTMLElement).getByRole('button', { name: RETRY_LABEL })).toBeInTheDocument();
        expect(missing?.getAttribute('style')).toContain('--ratio: 2400 / 1600');
        expect(container.querySelector('img, picture')).toBeNull();
        // The box sits on the stage's track (9a), and the stage on the Viewer's grid beside the moves.
        const stage = missing?.closest('[data-viewer-stage]')?.parentElement;
        for (const name of ['Previous photograph', 'Next photograph']) expect(screen.getByRole('link', { name }).parentElement).toBe(stage);
        expect(screen.getByRole('link', { name: 'Close' })).toHaveAttribute('href', '/work/fixture');
        // The next photograph starts without the failure.
        const OTHER = { ...REF, photoId: 'ph_00000000-0000-4000-8000-000000000004' };
        const next = model({ id: OTHER.photoId, image: { width: 1600, height: 2400, assetRevision: REF.assetRevision, variants: { ...variants(), w1200: { avif: { url: mediaUrl(OTHER, 'w1200', 'avif'), width: 1200 }, webp: { url: mediaUrl(OTHER, 'w1200', 'webp'), width: 1200 } } } } });
        rerender(<StoryViewer viewer={next} closeHref="/work/fixture" previousHref={null} nextHref={null} pendingCopy={null} />);
        expect(container.querySelector('[data-photo="unavailable"]')).toBeNull();
        expect(container.querySelector('img')).toHaveAttribute('src', mediaUrl(OTHER, 'w1200', 'webp'));
    });

    it('keeps the stage, its moves, and the reading area when the photo has no usable set, with Zoom disabled', () => {
        const { container } = renderViewer({ viewer: model({ image: null }) });
        expect(container.querySelector('img, picture, source')).toBeNull();
        const missing = container.querySelector('[data-photo="unavailable"]');
        expect(missing).toHaveTextContent(UNAVAILABLE_LABEL);
        expect(UNAVAILABLE_LABEL).toBe('Photograph unavailable');
        const zoom = screen.getByRole('button', { name: 'Zoom' });
        // Unavailable but focusable, so a move onto such a photo keeps focus on Zoom (#9).
        expect(zoom).toHaveAttribute('aria-disabled', 'true');
        expect(zoom).toBeEnabled();
        expect(zoom).toHaveAttribute('aria-pressed', 'false');
        fireEvent.click(zoom);
        expect(zoom).toHaveAttribute('aria-pressed', 'false');
        expect(screen.queryByRole('region', { name: 'Zoomed photograph' })).toBeNull();
        // Previous and Next stay links on the Viewer's grid, beside the box's own stage cell.
        const root = container.querySelector('[data-surface="viewer"]');
        expect(missing?.closest('[data-viewer-stage]')?.parentElement).toBe(root);
        for (const name of ['Previous photograph', 'Next photograph']) {
            const link = screen.getByRole('link', { name });
            expect(link).toHaveAttribute('data-replace', 'true');
            expect(link.parentElement).toBe(root);
        }
        const reading = screen.getByRole('region', { name: 'Fixture title' });
        expect(within(reading).getByText('An authored fixture caption.')).toBeInTheDocument();
        // No image carries the alt, so the reading area keeps the description, caption or not, and a screen reader hears it.
        expect(within(reading).getByText('A fixture description of the visible scene.')).toBeInTheDocument();
        expect(isInaccessible(within(reading).getByText('A fixture description of the visible scene.'))).toBe(false);
        expect(within(reading).getByRole('button', { name: SHOW_TECHNICAL })).toBeEnabled();
        expect(container.innerHTML).not.toContain('/media/');
    });

    describe('the description, said once (bug 9)', () => {
        const DESCRIPTION = 'A fixture description of the visible scene.';
        afterEach(() => vi.restoreAllMocks());

        /** What a screen reader hears of the description: images named by it, and text copies it can reach. */
        const spoken = () =>
            screen.queryAllByRole('img', { name: DESCRIPTION }).length + screen.queryAllByText(DESCRIPTION).filter((element) => !isInaccessible(element)).length;
        const label = () => screen.queryByText('Description');

        it.each([
            ['with a caption and a title', {}],
            ['with a caption and no title', { title: null }],
            ['with a title and no caption', { caption: null }],
            ['with neither', { title: null, caption: null }],
        ])('is heard once from the image %s', (_, photo) => {
            renderViewer({ viewer: model(photo) });
            expect(spoken()).toBe(1);
            expect(screen.getByRole('img', { name: DESCRIPTION })).toBeInTheDocument();
            const shown = label();
            // Without a caption the reading area still shows it, with its label, both hidden from a screen reader.
            if (shown !== null) {
                expect(isInaccessible(shown)).toBe(true);
                expect(isInaccessible(screen.getByText(DESCRIPTION))).toBe(true);
                expect(shown.parentElement).toHaveAttribute('aria-hidden', 'true');
            }
        });

        it('shows the description, hidden, only when there\'s no caption', () => {
            renderViewer({ viewer: model({ caption: null }) });
            expect(screen.getByText(DESCRIPTION)).toBeVisible();
            expect(label()).toBeVisible();
        });

        it('is heard once zoomed', () => {
            renderViewer({ viewer: model({ caption: null }) });
            fireEvent.click(screen.getByRole('button', { name: 'Zoom' }));
            expect(screen.getByRole('region', { name: 'Zoomed photograph' })).toBeInTheDocument();
            expect(spoken()).toBe(1);
        });

        it('is heard once, from the reading area, when there\'s no usable set to carry the alt', () => {
            for (const caption of [null, 'An authored fixture caption.']) {
                const { unmount } = renderViewer({ viewer: model({ caption, image: null, shareImage: null }) });
                expect(screen.queryByRole('img')).toBeNull();
                expect(spoken()).toBe(1);
                expect(isInaccessible(label()!)).toBe(false);
                unmount();
            }
        });

        it('is heard once after the file fails, from the failed box, which carries the alt', () => {
            renderViewer({ viewer: model({ caption: null }) });
            fireEvent.error(screen.getByRole('img', { name: DESCRIPTION }));
            expect(screen.queryByRole('img')).toBeNull();
            expect(spoken()).toBe(1);
            expect(isInaccessible(label()!)).toBe(true);
            expect(document.querySelector('[data-photo="unavailable"]')).toHaveTextContent(DESCRIPTION);
        });

        it('leaves the pending copy spoken: no image says it', () => {
            renderViewer({ viewer: model({ description: null, alt: '', descriptionPending: true, caption: null }), pendingCopy: 'Description pending editorial review' });
            expect(isInaccessible(screen.getByText('Description pending editorial review'))).toBe(false);
            expect(isInaccessible(label()!)).toBe(false);
        });
    });

    it('Retry on a failed photograph loads the same variant again, in a new image, keeping the box', () => {
        const { container } = renderViewer();
        const failed = screen.getByRole('img', { name: 'A fixture description of the visible scene.' });
        const before = [...container.querySelectorAll('source, img')].map((element) => [element.getAttribute('srcset'), element.getAttribute('sizes'), element.getAttribute('src')]);
        fireEvent.error(failed);
        const retry = screen.getByRole('button', { name: RETRY_LABEL });
        retry.focus();
        fireEvent.click(retry);
        const again = screen.getByRole('img', { name: 'A fixture description of the visible scene.' });
        // A new element, since a failed image doesn't fetch again, with the same files and sizes.
        expect(again).not.toBe(failed);
        expect([...container.querySelectorAll('source, img')].map((element) => [element.getAttribute('srcset'), element.getAttribute('sizes'), element.getAttribute('src')])).toEqual(before);
        expect(container.querySelector('[data-photo="unavailable"]')).toBeNull();
        // Focus doesn't drop to the page when the button it was on goes: it lands on the photograph's box.
        expect(document.activeElement).toBe(container.querySelector('figure[data-viewer-current]'));
    });

    it('puts focus on Retry again when a retry fails too, never on the page', () => {
        renderViewer();
        fireEvent.error(screen.getByRole('img'));
        const first = screen.getByRole('button', { name: RETRY_LABEL });
        first.focus();
        fireEvent.click(first);
        fireEvent.error(screen.getByRole('img'));
        const again = screen.getByRole('button', { name: RETRY_LABEL });
        expect(document.activeElement).toBe(again);
        // And a third try that loads lands on the photograph's box.
        fireEvent.click(again);
        expect(document.activeElement).toBe(document.querySelector('figure[data-viewer-current]'));
    });

    it('keeps the fitted width current as the box resizes, as when the modal opens, and zooms from the latest', () => {
        const observers: { callback: ResizeObserverCallback; target: Element | null }[] = [];
        vi.stubGlobal(
            'ResizeObserver',
            class {
                record: { callback: ResizeObserverCallback; target: Element | null };
                constructor(callback: ResizeObserverCallback) {
                    this.record = { callback, target: null };
                    observers.push(this.record);
                }
                observe(target: Element) {
                    this.record.target = target;
                }
                unobserve() {}
                disconnect() {
                    this.record.target = null;
                }
            },
        );
        try {
            const { container } = renderViewer();
            const figure = container.querySelector('figure')!;
            const resize = (width: number) =>
                act(() => {
                    for (const { callback, target } of observers) {
                        if (target === figure) callback([{ target, borderBoxSize: [{ inlineSize: width, blockSize: width / 1.5 }], contentRect: { width } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
                    }
                });
            // Measured before the box had its place (the modal before showModal()), then again once it has.
            resize(120);
            resize(500.4);
            fireEvent.click(screen.getByRole('button', { name: 'Zoom' }));
            // clamp(fitted, 2 * fitted, 1920), rounded up, never under the fitted width.
            expect(container.querySelector('source[type="image/webp"]')).toHaveAttribute('sizes', '1001px');
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('retries a failed AVIF file with WebP before it shows the failure (#6)', () => {
        const current = vi.spyOn(HTMLImageElement.prototype, 'currentSrc', 'get').mockReturnValue(`http://localhost${mediaUrl(REF, 'w1920', 'avif')}`);
        try {
            const { container } = renderViewer();
            fireEvent.error(screen.getByRole('img'));
            expect(container.querySelector('[data-photo="unavailable"]')).toBeNull();
            expect(container.querySelector('source[type="image/avif"]')).toBeNull();
            current.mockReturnValue(`http://localhost${mediaUrl(REF, 'w1920', 'webp')}`);
            fireEvent.error(screen.getByRole('img'));
            expect(container.querySelector('[data-photo="unavailable"]')).toHaveTextContent(FAILED_LABEL);
        } finally {
            current.mockRestore();
        }
    });

    it.each([
        // fitted, zoomed: clamp(fitted, 2 * fitted, the largest file's width).
        [600, 1200],
        [960, 1920],
        [1200, 1920],
        // A very wide screen: Zoom never shrinks the photograph.
        [2400, 2400],
    ])('zooms a photograph fitted at %i px to %i px', (fitted, zoomed) => {
        const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: fitted, height: fitted / 1.5, x: 0, y: 0, top: 0, left: 0, right: fitted, bottom: fitted / 1.5, toJSON: () => ({}) });
        try {
            const { container } = renderViewer();
            fireEvent.click(screen.getByRole('button', { name: 'Zoom' }));
            expect(container.querySelector('source[type="image/webp"]')).toHaveAttribute('sizes', `${zoomed}px`);
            expect((container.querySelector('figure') as HTMLElement).style.getPropertyValue('--zoom-width')).toBe(`${zoomed}px`);
        } finally {
            rect.mockRestore();
        }
    });

    it('pads the header to the digits of the total', () => {
        const { container } = renderViewer({ viewer: model({}, { position: 7, total: 120 }) });
        const header = container.querySelector('header')!;
        expect(within(header).getByText('007 / 120')).toHaveAttribute('aria-hidden', 'true');
        expect(within(header).getByRole('heading', { level: 1 })).toHaveAccessibleName('Fixture series, photograph 7 of 120');
    });

    // The heading's name is its aria-label, from the same data as its visible text, and what shows is hidden from
    // screen readers, so the title is said once, with no space before the comma and no text drawn at no size: a part that isn't inline gets a space on each side in the name.
    it.each([
        ['Fixture series', 'Fixture series, photograph 3 of 12'],
        ['Fixture shapes along the northern shoreline at the turn of the tide', 'Fixture shapes along the northern shoreline at the turn of the tide, photograph 3 of 12'],
    ])('names the heading "%s" by its aria-label, with its place, and hides the title it shows', (title, name) => {
        const { container } = renderViewer({ viewer: model({}, { series: { id: 'ser_fixture', slug: 'fixture', title, accent: null } }) });
        const heading = within(container.querySelector('header')!).getByRole('heading', { level: 1 });
        expect(heading).toHaveAttribute('aria-label', name);
        expect(heading).toHaveAccessibleName(name);
        // On screen: the series title alone, whole, in one part a screen reader skips.
        expect(heading.textContent).toBe(title);
        expect([...heading.childNodes].map((node) => (node instanceof Element ? node.getAttribute('aria-hidden') : `text: ${node.textContent}`))).toEqual(['true']);
        expect(heading.querySelector('.sr-only')).toBeNull();
    });

    it('names the heading of a photograph named by its place by the series title alone, in its aria-label', () => {
        const { container } = renderViewer({ viewer: model({ title: null, caption: null, description: null, alt: 'Photograph 3 of 12', namedByPlace: true, technical: {} }) });
        const heading = within(container.querySelector('header')!).getByRole('heading', { level: 1 });
        expect(heading).toHaveAttribute('aria-label', 'Fixture series');
        expect(heading.textContent).toBe('Fixture series');
        expect([...heading.childNodes].map((node) => (node instanceof Element ? node.getAttribute('aria-hidden') : `text: ${node.textContent}`))).toEqual(['true']);
    });

    it('renders authored text as text, never as markup', () => {
        const { container } = renderViewer({ viewer: model({ caption: '<img src=x onerror=alert(1)>', title: '<b>Bold</b>' }, { series: { id: 'ser_fixture', slug: 'fixture', title: '<i>Series</i>', accent: null } }) });
        expect(container.querySelectorAll('img')).toHaveLength(1);
        expect(container.querySelector('b, i')).toBeNull();
        expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    });

    it('sets the accent as an inline custom property only in #rrggbb form, the photo\'s before the series\'', () => {
        const root = (props: Partial<StoryViewerProps>) => {
            const { container, unmount } = renderViewer(props);
            const value = (container.firstElementChild as HTMLElement).style.getPropertyValue('--cc-accent');
            unmount();
            return value;
        };
        expect(root({})).toBe('#c08040');
        expect(root({ viewer: model({ accent: null }) })).toBe('#a0b0c0');
        expect(root({ viewer: model({ accent: 'red; background: url(x)' }, { series: { id: 'ser_fixture', slug: 'fixture', title: 'Fixture series', accent: null } }) })).toBe('');
        expect(accentValue('#c08040; color: red', 'x#a0b0c0', '#abc', '#c08040ff', '#A0B0C0')).toBe('#A0B0C0');
        expect(accentValue('#abc')).toBeNull();
    });
});

describe('viewerLabels', () => {
    it('pads the visible position to the digits of the total, never under two, and spells it out for a screen reader', () => {
        expect([positionLabel(3, 12), positionLabel(1, 1), positionLabel(12, 120), positionLabel(7, 120)]).toEqual(['03 / 12', '01 / 01', '012 / 120', '007 / 120']);
        expect(positionText(3, 12)).toBe('Photograph 3 of 12');
    });

    it('reads the camera facts in their units, the make said once, and drops a value that isn\'t a finite number', () => {
        const rows = (technical: Parameters<typeof technicalFacts>[0]) => technicalFacts(technical).map(({ label, value }) => `${label}: ${value}`);
        expect(rows({ Make: 'Canon', Model: 'Canon EOS R5', LensModel: 'RF24-70mm F2.8 L IS USM', FocalLength: '35', FNumber: '1.8', ExposureTime: '1/200', ISO: '400' })).toEqual([
            'Camera: Canon EOS R5',
            'Lens: RF24-70mm F2.8 L IS USM',
            'Focal length: 35 mm',
            'Aperture: f/1.8',
            'Exposure: 1/200 s',
            'ISO: 400',
        ]);
        // A make the model doesn't start with leads; a corporate make the model shortens is said once.
        expect(rows({ Make: 'SONY', Model: 'ILCE-7M3' })).toEqual(['Camera: SONY ILCE-7M3']);
        expect(rows({ Make: 'NIKON CORPORATION', Model: 'NIKON Z 6' })).toEqual(['Camera: NIKON Z 6']);
        expect(rows({ Make: 'FUJIFILM' })).toEqual(['Camera: FUJIFILM']);
        expect(rows({ Model: 'X100V' })).toEqual(['Camera: X100V']);
        expect(rows({ ExposureTime: '2', FocalLength: '23.5', FNumber: '11' })).toEqual(['Focal length: 23.5 mm', 'Aperture: f/11', 'Exposure: 2 s']);
        expect(rows({ ExposureTime: '0.3' })).toEqual(['Exposure: 0.3 s']);
        for (const bad of ['NaN', 'Infinity', '', 'abc', '1/0', '1/x', '-2', '0']) {
            expect(rows({ FocalLength: bad, FNumber: bad, ExposureTime: bad, ISO: bad }), bad).toEqual([]);
        }
    });

    it('titles a photo by its authored title, else by its series and position', () => {
        expect(viewerTitle('Fixture title', 'Fixture series', 3, 12)).toBe('Fixture title, Fixture series');
        expect(viewerTitle(null, 'Fixture series', 3, 12)).toBe('Fixture series, photograph 3 of 12');
    });
});
