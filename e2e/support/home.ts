import { expect, type Frame, type Page } from '@playwright/test';

/** Home's own page or the frame it renders in, such as #16's draft preview. */
type HomeTarget = Page | Frame;

/** The chrome's controls, as HomeChromeController matches them for its hover and press holds. */
const CONTROLS = 'a[href], button, input, select, textarea';

/** Where the frame's content box sits in its page, or the origin for a page. */
async function frameOffset(target: HomeTarget): Promise<{ x: number; y: number }> {
    if (!('frameElement' in target) || target.parentFrame() === null) return { x: 0, y: 0 };
    const element = await target.frameElement();
    try {
        return await element.evaluate((node) => {
            const frame = node as Element;
            const box = frame.getBoundingClientRect();
            const style = getComputedStyle(frame);
            return {
                x: box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
                y: box.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop),
            };
        });
    } finally {
        await element.dispose();
    }
}

/**
 * A point on the photograph clear of every chrome control: the vertical
 * centre at 70% of the viewport's width. Fails if any control's box holds it.
 * Returns it in page coordinates, for `page.mouse` and `page.touchscreen`.
 */
export async function photoPoint(target: HomeTarget): Promise<{ x: number; y: number }> {
    const { point, under } = await target.evaluate((selector) => {
        const x = Math.round(window.innerWidth * 0.7);
        const y = Math.round(window.innerHeight / 2);
        const under = Array.from(document.querySelectorAll(`[data-home-chrome] :is(${selector})`))
            .filter((control) => {
                const box = control.getBoundingClientRect();
                return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
            })
            .map((control) => control.getAttribute('aria-label') ?? control.textContent?.trim() ?? control.tagName);
        return { point: { x, y }, under };
    }, CONTROLS);
    expect(under, 'The photo point must clear every chrome control').toEqual([]);
    const offset = await frameOffset(target);
    return { x: point.x + offset.x, y: point.y + offset.y };
}

/**
 * Settled Home with a photograph, showing nothing but the photograph: the
 * intro settled, loading over, no no-photo hold, `immersive`, the chrome and
 * vignette at opacity 0, no portrait, and every control's centre hitting
 * something outside the chrome. Waits for each, since the fade is real time.
 */
export async function expectHomeImmersive(target: HomeTarget): Promise<void> {
    const main = target.locator('main[data-interface-state]');
    await expect(main).toHaveAttribute('data-home-intro', 'settled', { timeout: 20_000 });
    await expect(main).toHaveAttribute('data-home-loading', 'false');
    await expect(main).not.toHaveAttribute('data-chrome-holds', /\bno-photo\b/);
    await expect(main).toHaveAttribute('data-interface-state', 'immersive');
    for (const layer of ['[data-home-chrome]', '[data-home-vignette]']) {
        await expect(target.locator(layer)).toHaveCSS('opacity', '0');
    }
    await expect(target.locator('[class*="portrait"]')).toHaveCount(0);
    const caught = await target.evaluate((selector) => {
        const chrome = document.querySelector('[data-home-chrome]');
        if (!chrome) return ['no chrome layer'];
        return Array.from(chrome.querySelectorAll(selector)).flatMap((control) => {
            const box = control.getBoundingClientRect();
            if (box.width === 0 || box.height === 0) return [];
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            return hit && chrome.contains(hit) ? [control.getAttribute('aria-label') ?? control.textContent?.trim() ?? control.tagName] : [];
        });
    }, CONTROLS);
    expect(caught, 'Receded controls must take no pointer').toEqual([]);
}
