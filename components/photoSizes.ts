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
}

const round = (value: number, places: number) => Number(value.toFixed(places));

export function heightCappedSizes(width: number, height: number, heightVh: number, rules: readonly WidthRule[]): string {
    const shape = width / height;
    const cappedVh = round(heightVh * shape, 2);
    return rules
        .flatMap(({ media, vw }) => {
            // The height binds once viewport width over height passes this.
            const aspect = `(min-aspect-ratio: ${Math.round(((heightVh * shape) / vw) * 1000)}/1000)`;
            return [`${media ? `${media} and ` : ''}${aspect} ${cappedVh}vh`, `${media ? `${media} ` : ''}${vw}vw`];
        })
        .join(', ');
}
