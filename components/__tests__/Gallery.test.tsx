import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VARIANT_BYTES } from '@/lib/catalog/__tests__/catalogFixtures';
import { catalogPhotos } from '@/lib/catalog/photos-api';
import { publish } from '@/lib/catalog/publish';
import { createCatalogReader } from '@/lib/catalog/reader';
import { readRevisionFile } from '@/lib/catalog/repository';
import { createTestCatalog } from '@/lib/catalog/testing';
import Gallery from '../Gallery';
import { mediaImageLoader } from '../mediaImageLoader';

const CAPTION = 'Fixture Camera | 35mm f/1.8 1/200s ISO 100';

// Every other photo has a caption, the first included.
const images = Array.from({ length: 10 }, (_, index) => ({
    id: index,
    src: `/assets/photos/photo-${index + 1}.jpg`,
    width: 1200,
    height: 800,
    optimizedWidth: 1200,
    optimizedHeight: 800,
    caption: index % 2 === 0 ? CAPTION : undefined,
}));

const names = images.map((_, index) => `Photograph ${index + 1} of 10`);

describe('Gallery', () => {
    beforeEach(() => {
        // jsdom has no IntersectionObserver. This one never fires, so tiles 9 and 10 stay unloaded.
        vi.stubGlobal(
            'IntersectionObserver',
            class {
                observe() {}
                unobserve() {}
                disconnect() {}
                takeRecords() {
                    return [];
                }
            },
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('renders each photo as a button named by its position', () => {
        render(<Gallery images={images} />);
        const tiles = screen.getAllByRole('button');
        expect(tiles).toHaveLength(10);
        tiles.forEach((tile, index) => {
            expect(tile).toHaveAttribute('type', 'button');
            expect(tile).toHaveAccessibleName(names[index]);
        });
    });

    it('names the unloaded tiles 9 and 10 before their images mount', () => {
        render(<Gallery images={images} />);
        const tiles = screen.getAllByRole('button');
        for (const index of [8, 9]) {
            expect(tiles[index]).toHaveAccessibleName(names[index]);
            expect(tiles[index].querySelector('img')).toBeNull();
        }
    });

    it('nests no interactive or block element inside a tile', () => {
        render(<Gallery images={images} />);
        for (const tile of screen.getAllByRole('button')) {
            expect(tile.querySelectorAll('a, button, input, select, textarea, [tabindex], div, p')).toHaveLength(0);
        }
    });

    it('gives each image an empty alt, so the button alone carries the name', () => {
        render(<Gallery images={images} />);
        const tiles = screen.getAllByRole('button');
        for (const tile of tiles.slice(0, 8)) {
            expect(tile.querySelector('img')).toHaveAttribute('alt', '');
        }
        expect(screen.queryAllByRole('img')).toHaveLength(0);
    });

    it('describes a tile by its caption, loaded or not', () => {
        render(<Gallery images={images} />);
        const tiles = screen.getAllByRole('button');
        expect(tiles[0]).toHaveAccessibleDescription(CAPTION);
        expect(tiles[1]).toHaveAccessibleDescription('');
        expect(tiles[8]).toHaveAccessibleDescription(CAPTION);
    });

    it('serves a legacy derivative through /_next/image, as before', () => {
        render(<Gallery images={images} />);
        expect(screen.getAllByRole('button')[0].querySelector('img')?.getAttribute('src')).toMatch(/^\/_next\/image\?url=%2Fassets%2Fphotos%2F/);
    });

    it("fills a published catalog item's tile from its own /media set, never through /_next/image", { timeout: 30_000 }, async () => {
        const catalog = await createTestCatalog({ seed: 131, photos: 2, series: 1, variantBytes: VARIANT_BYTES });
        try {
            const published = await publish({ dataRoot: catalog.root, actor: 'test', confirmLaunch: true, logger: { log: () => undefined } });
            const revision = await readRevisionFile(catalog.root, published.revisionId ?? '');
            if (!revision) throw new Error(`The publish ended ${published.outcome}: ${published.message}`);
            const items = catalogPhotos(createCatalogReader(revision.content, { revisionId: revision.revisionId, revisionNumber: 1 }));
            expect(items[0].src).toMatch(/^\/media\/.+\/w1920\.webp$/);
            render(<Gallery images={items} />);
            const set = items[0].src.replace(/w1920\.webp$/, '');
            const image = screen.getAllByRole('button')[0].querySelector('img');
            const urls = [image?.getAttribute('src') ?? '', ...(image?.getAttribute('srcset') ?? '').split(', ').map((entry) => entry.split(' ')[0])];
            expect(urls.length).toBeGreaterThan(1);
            for (const url of urls) {
                expect(url).not.toContain('/_next/image');
                expect(url.startsWith(set) && /^w(400|800|1200|1920)\.webp$/.test(url.slice(set.length)), url).toBe(true);
            }
        } finally {
            await catalog.cleanup();
        }
    });
});

describe('mediaImageLoader', () => {
    const set = '/media/ph_x/rev/p/';
    it.each([
        [1, 'w400'],
        [400, 'w400'],
        [401, 'w800'],
        [1200, 'w1200'],
        [1921, 'w1920'],
        [3840, 'w1920'],
    ])('serves width %i from %s of the same set and format', (width, variant) => {
        expect(mediaImageLoader({ src: `${set}w1920.webp`, width })).toBe(`${set}${variant}.webp`);
        expect(mediaImageLoader({ src: `${set}w400.avif`, width })).toBe(`${set}${variant}.avif`);
    });

    it('refuses anything but a /media variant', () => {
        expect(() => mediaImageLoader({ src: '/assets/photos/optimized/a.webp', width: 400 })).toThrow(/only loads \/media variants/);
    });
});
