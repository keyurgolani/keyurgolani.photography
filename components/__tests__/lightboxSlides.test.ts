// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { lightboxSlides } from '../lightboxSlides';

describe('lightboxSlides', () => {
    it('sizes each slide as the optimized file it loads, not as the photo', () => {
        // Gallery items also carry the photo's own size, which lays out the tiles.
        const images = [
            { src: '/assets/photos/optimized/wide.webp', thumbnail: '/assets/photos/thumbnails/wide.webp', width: 6000, height: 4000, optimizedWidth: 1920, optimizedHeight: 1280 },
            { src: '/assets/photos/optimized/small.webp', width: 960, height: 640, optimizedWidth: 960, optimizedHeight: 640 },
        ];

        expect(lightboxSlides(images)).toEqual([
            { src: '/assets/photos/optimized/wide.webp', thumbnail: '/assets/photos/thumbnails/wide.webp', width: 1920, height: 1280 },
            { src: '/assets/photos/optimized/small.webp', thumbnail: '/assets/photos/optimized/small.webp', width: 960, height: 640 },
        ]);
    });
});
