import type { SlideImage } from 'yet-another-react-lightbox';

export interface SlideSource {
    /** The optimized WebP. */
    src: string;
    thumbnail?: string;
    /** The size of the file at `src`, which is smaller than the photo once it is wider than 1920 px. */
    optimizedWidth: number;
    optimizedHeight: number;
}

/**
 * The Lightbox's slides, each sized as the file it loads rather than as the
 * photo. Until that file loads, the Zoom plugin takes its zoom limit from the
 * slide's size, and it doesn't lower a zoom already past the limit once the
 * file's own size arrives.
 */
export function lightboxSlides(images: readonly SlideSource[]): SlideImage[] {
    return images.map((image) => ({
        src: image.src,
        thumbnail: image.thumbnail || image.src,
        width: image.optimizedWidth,
        height: image.optimizedHeight,
    }));
}
