import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '@/lib/identity/variants';
import { mediaUrl } from '@/lib/media/url';
import type { SeriesImage } from '@/lib/catalog/projections/series';
import SeriesPhoto from '../SeriesPhoto';

const REF = { photoId: 'ph_00000000-0000-4000-8000-000000000001', assetRevision: `sha256-${'c'.repeat(64)}`, profileId: 'p_0123456789abcdef' };
const LQIP = 'data:image/webp;base64,UklGRhIAAABXRUJQVlA4';

function image(width = 1800, height = 1200, lqip?: string): SeriesImage {
    const variants = {} as SeriesImage['variants'];
    for (const variant of VARIANT_WIDTHS) {
        const target = Math.min(Number(variant.slice(1)), width);
        variants[variant] = {} as SeriesImage['variants'][typeof variant];
        for (const format of VARIANT_FORMATS) variants[variant][format] = { url: mediaUrl(REF, variant, format), width: target };
    }
    return { width, height, variants, ...(lqip ? { lqip } : {}) };
}

const base = { alt: 'Fog over the ridge', sizes: '100vw', fallbackLabel: 'Photograph unavailable', frameClassName: 'frame' };

describe('SeriesPhoto', () => {
    it('renders the set through ResponsivePhoto, lazily by default, in its reserved box', () => {
        const { container } = render(<SeriesPhoto {...base} image={image()} />);
        const img = container.querySelector('img') as HTMLImageElement;
        expect(img.getAttribute('src')).toBe(mediaUrl(REF, 'w1200', 'webp'));
        expect(img.getAttribute('alt')).toBe('Fog over the ridge');
        expect(img.getAttribute('loading')).toBe('lazy');
        expect(img.hasAttribute('fetchpriority')).toBe(false);
        const frame = container.firstElementChild as HTMLElement;
        expect(frame.className).toBe('frame');
        expect(frame.getAttribute('data-photo')).toBe('cover');
        // The class sets the box's shape unless the photograph's own ratio is asked for.
        expect(frame.style.aspectRatio).toBe('');
        expect(frame.style.getPropertyValue('--ratio')).toBe('');
    });

    it('loads the cover at once, at high priority, in a box at the photograph\'s own ratio around its focal point', () => {
        const { container } = render(<SeriesPhoto {...base} image={image(1800, 1200, LQIP)} priority intrinsic focalPoint={{ x: 0.2, y: 0.9 }} crop="contain" />);
        const img = container.querySelector('img') as HTMLImageElement;
        expect(img.getAttribute('loading')).toBe('eager');
        expect(img.getAttribute('fetchpriority')).toBe('high');
        // The cover is preloaded from the head with its own srcset (#6).
        expect(document.head.querySelector('link[rel="preload"][as="image"]')?.getAttribute('imagesrcset')).toBe(
            container.querySelector('source[type="image/avif"]')?.getAttribute('srcset'),
        );
        expect(img.style.backgroundImage).toBe(`url("${LQIP}")`);
        const frame = container.firstElementChild as HTMLElement;
        expect(frame.style.aspectRatio).toBe('1800 / 1200');
        // The class caps the width with it, so the height cap can't crop the box.
        expect(frame.style.getPropertyValue('--ratio')).toBe('1800 / 1200');
        expect(frame.style.getPropertyValue('--focal-x')).toBe('20%');
        expect(frame.style.getPropertyValue('--focal-y')).toBe('90%');
        expect(frame.getAttribute('data-photo')).toBe('contain');
    });

    it('shows its fallback text, never a broken image, when there is no set', () => {
        const { container } = render(<SeriesPhoto {...base} image={null} />);
        expect(container.querySelector('img')).toBeNull();
        const frame = container.querySelector('[data-photo="unavailable"]');
        expect(frame?.textContent).toBe('Photograph unavailable');
        // Outside a link, the fallback text is the photograph's only text, so it stays readable.
        expect(frame?.querySelector('[aria-hidden]')).toBeNull();
        expect(frame?.className).toContain('frame');
    });

    it('swaps in the fallback when the image fails to load, with no text when it has no label, as inside a named link', () => {
        const { container } = render(<SeriesPhoto {...base} alt="" image={image()} fallbackLabel={undefined} />);
        fireEvent.error(container.querySelector('img') as HTMLImageElement);
        expect(container.querySelector('img')).toBeNull();
        const frame = container.querySelector('[data-photo="unavailable"]');
        expect(frame?.className).toContain('frame');
        expect(frame?.textContent).toBe('');
    });

    it('catches an image that failed before hydration, and leaves one that hasn\'t started alone', () => {
        const complete = vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
        const natural = vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(0);
        const current = vi.spyOn(HTMLImageElement.prototype, 'currentSrc', 'get').mockReturnValue(mediaUrl(REF, 'w1200', 'webp'));
        try {
            const failed = render(<SeriesPhoto {...base} image={image()} />);
            expect(failed.container.querySelector('[data-photo="unavailable"]')).not.toBeNull();
            current.mockReturnValue('');
            const pending = render(<SeriesPhoto {...base} image={image()} />);
            expect(pending.container.querySelector('img')).not.toBeNull();
        } finally {
            complete.mockRestore();
            natural.mockRestore();
            current.mockRestore();
        }
    });
});
