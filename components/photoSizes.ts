/**
 * `sizes` for a photograph shown whole in a box that's capped both ways: at
 * most `heightVh` of the viewport tall, and as wide as the first width rule
 * whose media matches. Once the viewport is wider than the photograph's shape
 * allows, the height cap sets the width, so a tall photograph on a wide screen
 * asks for the rung it renders at instead of the full column's (#6).
 *
 * The last rule takes no media. The height is a viewport share, so a box
 * that's a little shorter (a header above it) still gets a rung that covers it.
 */
export interface WidthRule {
    /** A media condition, such as `(min-width: 48rem)`. Absent on the last rule. */
    media?: string;
    /** The box's width there, in vw. */
    vw: number;
    /**
     * A fixed height the box gives up there, in rem, on top of the viewport share: the header and the stage's padding,
     * where they're a large part of a short screen. The height cap is then `calc(heightVh vh - offset)` times the shape.
     */
    offsetRem?: number;
}

const round = (value: number, places: number) => Number(value.toFixed(places));

export function heightCappedSizes(width: number, height: number, heightVh: number, rules: readonly WidthRule[]): string {
    const shape = width / height;
    const cappedVh = round(heightVh * shape, 2);
    return rules
        .flatMap(({ media, vw, offsetRem }) => {
            // The height binds once viewport width over height passes this, and sooner with an offset, where the width
            // rule's larger size still covers the box.
            const aspect = `(min-aspect-ratio: ${Math.round(((heightVh * shape) / vw) * 1000)}/1000)`;
            const capped = offsetRem ? `calc(${cappedVh}vh - ${round(offsetRem * shape, 4)}rem)` : `${cappedVh}vh`;
            return [`${media ? `${media} and ` : ''}${aspect} ${capped}`, `${media ? `${media} ` : ''}${vw}vw`];
        })
        .join(', ');
}

/** How a photograph fills its box: cut to fill it, or shown whole inside it. A photo's authored `crop`. */
export type Fit = 'cover' | 'contain';

/**
 * The box a photograph is drawn in, where `media` holds: `vw` of the
 * viewport wide, less `lessRem` (gutters and gaps), and either a shape of its
 * own (`ratio`, width over height) or a height the screen sets (`heightVh`).
 */
export type PhotoBox = { media?: string; vw: number; lessRem?: number } & ({ ratio: number; heightVh?: never } | { heightVh: number; ratio?: never });

const length = (vw: number, lessRem = 0) => (lessRem > 0 ? `calc(${round(vw, 2)}vw - ${round(lessRem, 2)}rem)` : `${round(vw, 2)}vw`);

/**
 * #6's size rule, for every photograph a screen draws in a box: the width it
 * needs is the larger of the box's width and the box's height times the
 * photograph's shape for a cover crop, and the smaller for a contain one.
 * The browser multiplies that by the pixel ratio and takes the smallest rung
 * at or above it. Boxes come in order, the media ones first and the last
 * with none, as `sizes` takes them.
 *
 * A box of its own shape scales its width by one factor. A box the screen's
 * height sets switches between its width and the height times the shape at
 * the viewport aspect ratio where the two meet, which leaves `lessRem` out,
 * so close to that ratio a box with gutters can ask for a little more than
 * the width it's drawn at. The height is a viewport share (vh, which svh
 * never exceeds), so a box a little shorter still gets a rung that covers it.
 */
export function photoSizes(photo: { width: number; height: number }, fit: Fit, boxes: readonly PhotoBox[]): string {
    const shape = photo.width / photo.height;
    return boxes
        .flatMap((box) => {
            const media = box.media ? `${box.media} ` : '';
            const width = length(box.vw, box.lessRem);
            if (box.ratio !== undefined) {
                const scale = fit === 'cover' ? Math.max(1, shape / box.ratio) : Math.min(1, shape / box.ratio);
                return [`${media}${length(box.vw * scale, (box.lessRem ?? 0) * scale)}`];
            }
            // Past this viewport aspect ratio the box's width is more than the photograph at the box's height.
            const aspect = `(min-aspect-ratio: ${Math.round(((box.heightVh * shape) / box.vw) * 1000)}/1000)`;
            const atHeight = `${round(box.heightVh * shape, 2)}vh`;
            const [onWide, onNarrow] = fit === 'cover' ? [width, atHeight] : [atHeight, width];
            return [`${box.media ? `${box.media} and ` : ''}${aspect} ${onWide}`, `${media}${onNarrow}`];
        })
        .join(', ');
}
