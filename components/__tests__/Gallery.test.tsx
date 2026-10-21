import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Gallery from '../Gallery';

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
});
