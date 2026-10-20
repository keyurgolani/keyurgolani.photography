import { expect, type ElementHandle, type Locator } from '@playwright/test';
import sharp from 'sharp';
import { waitForHydration } from './hydration';

const MARK = 'data-e2e-contrast';

type Rgb = readonly [number, number, number];

function luminance([r, g, b]: Rgb): number {
    const linear = (channel: number) => {
        const c = channel / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: Rgb, b: Rgb): number {
    const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Contract rule 8: text and `currentColor` icons on photographs keep `min`
 * contrast against every pixel behind them. Screenshots the target's box with
 * its text and icons transparent, then composites the computed foreground, at
 * its opacity up the tree, over each pixel and keeps the worst ratio.
 * Returns that ratio.
 *
 * It measures the settled state. The screenshot finishes any running
 * transition, and the opacity is read after it, so a fade still in progress
 * counts at its end value.
 */
export async function expectContrastOverImage(target: Locator, { min }: { min: number }): Promise<number> {
    await waitForHydration(target.page());
    // The color has to be read before the screenshot hides it.
    const color = await target.evaluate((el, mark) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('No 2D canvas to resolve the text color');
        context.fillStyle = getComputedStyle(el).color;
        context.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
        el.setAttribute(mark, '');
        return { rgb: [r, g, b] as const, alpha: a / 255 };
    }, MARK);

    let style: ElementHandle<Node> | undefined;
    let png: Buffer;
    let opacity: number;
    try {
        style = await target.page().addStyleTag({
            content: `[${MARK}], [${MARK}] * { color: transparent !important; -webkit-text-fill-color: transparent !important; transition: none !important; }`,
        });
        png = await target.screenshot({ animations: 'disabled', caret: 'hide' });
        opacity = await target.evaluate((el) => {
            let product = 1;
            for (let node: Element | null = el; node; node = node.parentElement) product *= parseFloat(getComputedStyle(node).opacity);
            return product;
        });
    } finally {
        await style?.evaluate((node) => {
            node.parentNode?.removeChild(node);
        });
        await target.evaluate((el, mark) => el.removeAttribute(mark), MARK);
    }

    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { rgb } = color;
    const alpha = color.alpha * opacity;
    let worst = Infinity;
    for (let i = 0; i < data.length; i += info.channels) {
        const behind: Rgb = [data[i], data[i + 1], data[i + 2]];
        const blend = (c: number) => rgb[c] * alpha + behind[c] * (1 - alpha);
        worst = Math.min(worst, contrast([blend(0), blend(1), blend(2)], behind));
    }
    expect(worst, `Worst contrast of ${target} over the pixels behind it`).toBeGreaterThanOrEqual(min);
    return worst;
}
