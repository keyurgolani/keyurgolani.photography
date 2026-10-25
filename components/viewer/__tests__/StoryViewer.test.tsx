import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '@/lib/identity/variants';
import { mediaUrl } from '@/lib/media/url';
import type { PublishedViewerPhoto, ViewerImage } from '@/lib/catalog/projections/viewer';
import StoryViewer, { FIT_SIZES, type StoryViewerProps } from '../StoryViewer';
import { HIDE_TECHNICAL, SHOW_TECHNICAL, TECHNICAL_SOURCE, UNAVAILABLE_LABEL, accentValue, positionLabel, positionText, viewerTitle } from '../viewerLabels';

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
            ladder[width][format] = { url: mediaUrl(REF, width, format), width: pixels, height: Math.round((pixels * 2) / 3), bytes: 1_000 };
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
            image: { width: 2400, height: 1600, assetRevision: REF.assetRevision, variants: variants() },
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
        expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent('Fixture series');
        expect(header).toHaveTextContent('03 / 12');
        // The padded form is for the eye; a screen reader reads the spelled-out position instead.
        expect(within(header).getByText('03 / 12')).toHaveAttribute('aria-hidden', 'true');
        expect(within(header).getByText('Photograph 3 of 12')).toHaveClass('sr-only');
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
        expect(container.querySelector('source[type="image/avif"]')).toHaveAttribute('sizes', FIT_SIZES);
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
        expect(screen.getByRole('button', { name: 'Previous photograph' })).toBeDisabled();
        expect(screen.getByRole('link', { name: 'Next photograph' })).toBeInTheDocument();
        first.unmount();

        renderViewer({ nextHref: null });
        expect(screen.getByRole('button', { name: 'Next photograph' })).toBeDisabled();
        expect(screen.getByRole('link', { name: 'Previous photograph' })).toBeInTheDocument();
    });

    it('keeps authored copy apart from the camera facts, which start collapsed', () => {
        const { container } = renderViewer();
        const reading = screen.getByRole('region', { name: 'Fixture title' });
        expect(within(reading).getByRole('heading', { level: 2 })).toHaveTextContent('Fixture title');
        expect(within(reading).getByText('An authored fixture caption.')).toBeInTheDocument();
        expect(within(reading).getByText('Description').nextElementSibling).toHaveTextContent('A fixture description of the visible scene.');
        const toggle = within(reading).getByRole('button', { name: SHOW_TECHNICAL });
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        const panel = container.querySelector(`#${CSS.escape(toggle.getAttribute('aria-controls') ?? '')}`);
        expect(panel).not.toBeNull();
        expect(panel).not.toBeVisible();
        expect(panel).toHaveTextContent(TECHNICAL_SOURCE);
        // Camera facts never stand in for authored copy.
        for (const fact of ['Fixture Make', 'Fixture Model']) {
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
        expect([...(facts?.querySelectorAll('dt') ?? [])].map((term) => term.textContent)).toEqual(['Camera make', 'Camera', 'Aperture', 'ISO']);
        expect([...(facts?.querySelectorAll('dd') ?? [])].map((value) => value.textContent)).toEqual(['Fixture Make', 'Fixture Model', '2.8', '200']);
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

    it('shows the pending copy only when the page passes it, in place of the description', () => {
        renderViewer({ viewer: model({ description: null, alt: '', descriptionPending: true }), pendingCopy: 'Description pending editorial review' });
        expect(screen.getByText('Description pending editorial review')).toHaveAttribute('data-description', 'pending');
    });

    it('keeps the stage, its moves, and the reading area when the photo has no usable set, with Zoom disabled', () => {
        const { container } = renderViewer({ viewer: model({ image: null }) });
        expect(container.querySelector('img, picture, source')).toBeNull();
        const missing = container.querySelector('[data-photo="unavailable"]');
        expect(missing).toHaveTextContent(UNAVAILABLE_LABEL);
        expect(UNAVAILABLE_LABEL).toBe('Photograph unavailable');
        const zoom = screen.getByRole('button', { name: 'Zoom' });
        expect(zoom).toBeDisabled();
        expect(zoom).toHaveAttribute('aria-pressed', 'false');
        fireEvent.click(zoom);
        expect(screen.queryByRole('region', { name: 'Zoomed photograph' })).toBeNull();
        // Previous and Next stay links in the stage, either side of the box.
        const stage = missing?.parentElement?.parentElement;
        for (const name of ['Previous photograph', 'Next photograph']) {
            const link = screen.getByRole('link', { name });
            expect(link).toHaveAttribute('data-replace', 'true');
            expect(link.parentElement).toBe(stage);
        }
        const reading = screen.getByRole('region', { name: 'Fixture title' });
        expect(within(reading).getByText('An authored fixture caption.')).toBeInTheDocument();
        expect(within(reading).getByText('A fixture description of the visible scene.')).toBeInTheDocument();
        expect(within(reading).getByRole('button', { name: SHOW_TECHNICAL })).toBeEnabled();
        expect(container.innerHTML).not.toContain('/media/');
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
    it('pads the visible position to two digits and spells it out for a screen reader', () => {
        expect([positionLabel(3, 12), positionLabel(1, 1), positionLabel(12, 120)]).toEqual(['03 / 12', '01 / 01', '12 / 120']);
        expect(positionText(3, 12)).toBe('Photograph 3 of 12');
    });

    it('titles a photo by its authored title, else by its series and position', () => {
        expect(viewerTitle('Fixture title', 'Fixture series', 3, 12)).toBe('Fixture title, Fixture series');
        expect(viewerTitle(null, 'Fixture series', 3, 12)).toBe('Fixture series, photograph 3 of 12');
    });
});
