import type { Locator, Page } from '@playwright/test';
import sharp from 'sharp';

export type Rgb = readonly [number, number, number];

/** What the nav paints, read off the page: compare one theme's against the other's. */
export interface NavPaint {
    /** background, ink, border, and glass of the nav and of each descendant that renders, in document order. */
    styles: readonly string[];
    /** The nav's background composited over its ancestors' and the canvas, which is what shows wherever nothing else sits behind it. */
    ground: Rgb;
}

const PAINT_PROPERTIES = ['background-color', 'background-image', 'color', 'border-color', 'box-shadow', 'backdrop-filter', 'opacity', 'text-decoration-color'];

/**
 * The nav's paint. The toggle swaps its icon and name by theme with
 * display: none, so only rendered elements count, keyed by tag, and an svg's
 * shapes count as the svg. The ground
 * walks the ancestors from the nav up and paints each background-color under
 * the last, ending on the canvas: html's background, or body's when html has
 * none, or white.
 */
export function navPaint(nav: Locator): Promise<NavPaint> {
    return nav.evaluate((el, properties) => {
        const parse = (value: string): [number, number, number, number] => {
            const parts = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(value);
            if (!parts) return [0, 0, 0, 0];
            return [Number(parts[1]), Number(parts[2]), Number(parts[3]), parts[4] === undefined ? 1 : Number(parts[4])];
        };
        // An icon's own shapes differ by design (the sun and the moon), so an svg counts as one element.
        const rendered = [el, ...Array.from(el.querySelectorAll('*'))].filter(
            (node) => node.parentElement?.closest('svg') === null && (node as HTMLElement).getClientRects().length > 0,
        );
        const styles = rendered.map((node) => {
            const style = getComputedStyle(node);
            return `${node.tagName.toLowerCase()} ${properties.map((name) => `${name}: ${style.getPropertyValue(name)}`).join('; ')}`;
        });

        const layers: [number, number, number, number][] = [];
        for (let node: Element | null = el; node; node = node.parentElement) layers.push(parse(getComputedStyle(node).backgroundColor));
        const html = parse(getComputedStyle(document.documentElement).backgroundColor);
        const body = parse(getComputedStyle(document.body).backgroundColor);
        const canvas = html[3] > 0 ? html : body[3] > 0 ? body : [255, 255, 255, 1];
        let ground: number[] = canvas.slice(0, 3);
        for (const [r, g, b, a] of layers.reverse()) ground = [r * a + ground[0] * (1 - a), g * a + ground[1] * (1 - a), b * a + ground[2] * (1 - a)];
        return { styles, ground: ground.map(Math.round) as unknown as [number, number, number] };
    }, PAINT_PROPERTIES);
}

/** The mean color of the nav's own box with everything inside it hidden: its ground as painted, glass and blur included. */
export async function navPixels(nav: Locator): Promise<Rgb> {
    const page = nav.page();
    const style = await page.addStyleTag({ content: 'nav[aria-label="Primary"] * { visibility: hidden !important; transition: none !important; }' });
    try {
        const png = await nav.screenshot({ animations: 'disabled', caret: 'hide' });
        return mean(png);
    } finally {
        await style.evaluate((node) => node.parentNode?.removeChild(node));
    }
}

async function mean(png: Buffer): Promise<Rgb> {
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const sum = [0, 0, 0];
    for (let i = 0; i < data.length; i += info.channels) for (let c = 0; c < 3; c++) sum[c] += data[i + c];
    const count = data.length / info.channels;
    return [Math.round(sum[0] / count), Math.round(sum[1] / count), Math.round(sum[2] / count)];
}

/**
 * The viewport's bottom pixel row, scrolled to the bottom of the page, at its
 * two edges (`edge` px each), where no content sits and a strip under a short
 * page would show.
 */
export async function bottomRowEdges(page: Page, edge = 8): Promise<Rgb[]> {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForFunction(() => Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight - 1);
    const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const row = (info.height - 1) * info.width * info.channels;
    const pixels: Rgb[] = [];
    for (const x of [...Array.from({ length: edge }, (_, i) => i), ...Array.from({ length: edge }, (_, i) => info.width - 1 - i)]) {
        const at = row + x * info.channels;
        pixels.push([data[at], data[at + 1], data[at + 2]]);
    }
    return pixels;
}

/**
 * The window's own ground: the canvas, read with every child of the body
 * taken out of layout, so nothing but the canvas shows. It's what overscroll
 * and a collapsing mobile toolbar reveal past the page, which a headless
 * browser can't do itself. The canvas is html's background, or body's when
 * html has none.
 */
export async function windowGround(page: Page): Promise<Rgb> {
    const style = await page.addStyleTag({ content: 'body > * { display: none !important; } body { transition: none !important; }' });
    try {
        return mean(await page.screenshot({ animations: 'disabled', caret: 'hide' }));
    } finally {
        await style.evaluate((node) => node.parentNode?.removeChild(node));
    }
}

/** The computed background-color of html and body. */
export function rootGrounds(page: Page): Promise<{ html: string; body: string }> {
    return page.evaluate(() => ({ html: getComputedStyle(document.documentElement).backgroundColor, body: getComputedStyle(document.body).backgroundColor }));
}

/** Whether two colors are within `tolerance` on every channel. */
export const near = (a: Rgb, b: Rgb, tolerance = 2) => a.every((channel, i) => Math.abs(channel - b[i]) <= tolerance);
