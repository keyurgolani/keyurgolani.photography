import fs from 'node:fs';
import path from 'node:path';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '@/lib/identity/variants';
import { mediaUrl } from '@/lib/media/url';
import type { SeriesImage } from '@/lib/catalog/projections/series';
import { REPO_ROOT } from '../../../test/helpers/runTsx';
import SeriesPhoto from '../SeriesPhoto';

const REF = { photoId: 'ph_00000000-0000-4000-8000-000000000001', assetRevision: `sha256-${'c'.repeat(64)}`, profileId: 'p_0123456789abcdef' };
const LQIP = 'data:image/webp;base64,UklGRhIAAABXRUJQVlA4';

function image(width = 1800, height = 1200, lqip?: string): SeriesImage {
    const variants = {} as SeriesImage['variants'];
    for (const variant of VARIANT_WIDTHS) {
        const target = Math.min(Number(variant.slice(1)), width);
        variants[variant] = {} as SeriesImage['variants'][typeof variant];
        for (const format of VARIANT_FORMATS) variants[variant][format] = { url: mediaUrl(REF, variant, format), width: target, height: Math.round((target * height) / width), bytes: 1_000 };
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
    });

    it('loads the cover at once, at high priority, in a box at the photograph\'s own ratio around its focal point', () => {
        const { container } = render(<SeriesPhoto {...base} image={image(1800, 1200, LQIP)} priority intrinsic focalPoint={{ x: 0.2, y: 0.9 }} crop="contain" />);
        const img = container.querySelector('img') as HTMLImageElement;
        expect(img.getAttribute('loading')).toBe('eager');
        expect(img.getAttribute('fetchpriority')).toBe('high');
        expect(img.style.backgroundImage).toBe(`url("${LQIP}")`);
        const frame = container.firstElementChild as HTMLElement;
        expect(frame.style.aspectRatio).toBe('1800 / 1200');
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
    });

    it('swaps in the fallback when the image fails to load, and hides its text inside a named link', () => {
        const { container } = render(<SeriesPhoto {...base} alt="" image={image()} fallbackLabel="Image unavailable" fallbackHidden />);
        fireEvent.error(container.querySelector('img') as HTMLImageElement);
        expect(container.querySelector('img')).toBeNull();
        const frame = container.querySelector('[data-photo="unavailable"]');
        expect(frame?.className).toContain('frame');
        expect(frame?.querySelector('[aria-hidden="true"]')?.textContent).toBe('Image unavailable');
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

describe('the series page\'s client modules', () => {
    // A 'use client' module ships to visitors with everything it imports. The projection pulls in node:crypto and zod.
    it('take only types from the catalog read path', () => {
        const dir = path.join(REPO_ROOT, 'components/series');
        const clients = fs.readdirSync(dir).filter((name) => /\.tsx?$/.test(name) && /^\s*['"]use client['"]/.test(fs.readFileSync(path.join(dir, name), 'utf8')));
        expect(clients).toEqual(['SeriesPhoto.tsx']);
        for (const name of clients) {
            const source = fs.readFileSync(path.join(dir, name), 'utf8');
            for (const [statement] of source.matchAll(/^import\s[^;]*?from\s+['"][^'"]*lib\/catalog\/[^'"]*['"];?/gm)) expect(statement, `${name}: ${statement}`).toMatch(/^import type /);
        }
    });
});
