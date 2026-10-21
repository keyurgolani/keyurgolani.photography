import { expect, type Locator } from '@playwright/test';
import { waitForHydration } from './hydration';
import { measure } from './measure';

/** Slack for clientWidth and clientHeight, which round to whole px. */
const SLACK = 0.5;

/**
 * Contract rule 9: at 320 by 640 CSS px with a 200% root font size, every
 * control `controls` matches stays inside the viewport, clear of the other
 * controls and of any clipping ancestor. Restores the viewport and root font
 * size afterwards.
 */
export async function expectReflow(controls: Locator): Promise<void> {
    const page = controls.page();
    await waitForHydration(page);
    await controls.first().waitFor({ state: 'attached' });
    const viewport = page.viewportSize();
    const fontSize = await page.evaluate(() => {
        const previous = document.documentElement.style.getPropertyValue('font-size');
        document.documentElement.style.setProperty('font-size', '200%');
        return previous;
    });
    try {
        await page.setViewportSize({ width: 320, height: 640 });
        const problems: string[] = [];

        const overlaps = await controls.evaluateAll((elements, slack) => {
            const boxes = elements.map((el) => el.getBoundingClientRect());
            const found: [number, number][] = [];
            for (let i = 0; i < elements.length; i++) {
                for (let j = i + 1; j < elements.length; j++) {
                    if (elements[i].contains(elements[j]) || elements[j].contains(elements[i])) continue;
                    const [a, b] = [boxes[i], boxes[j]];
                    const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
                    const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                    if (width > slack && height > slack) found.push([i, j]);
                }
            }
            return found;
        }, SLACK);
        for (const [i, j] of overlaps) problems.push(`${controls.nth(i)} overlaps ${controls.nth(j)}`);

        for (const control of await controls.all()) {
            // Scroll vertically only: panning sideways would hide the overflow this checks for.
            await control.evaluate((el) => {
                el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
                window.scrollTo({ left: 0, top: window.scrollY, behavior: 'instant' });
            });
            const { box, clips, viewport: view } = await measure(control);
            const outside = [
                box.left < -SLACK ? `left edge at ${box.left.toFixed(1)}` : '',
                box.right > view.width + SLACK ? `right edge at ${box.right.toFixed(1)} of ${view.width}` : '',
                box.top < -SLACK ? `top edge at ${box.top.toFixed(1)}` : '',
                box.bottom > view.height + SLACK ? `bottom edge at ${box.bottom.toFixed(1)} of ${view.height}` : '',
            ].filter(Boolean);
            if (outside.length > 0) problems.push(`${control} extends past the viewport: ${outside.join(', ')}`);
            for (const clip of clips) {
                const cut = (clip.x && (box.left < clip.box.left - SLACK || box.right > clip.box.right + SLACK))
                    || (clip.y && (box.top < clip.box.top - SLACK || box.bottom > clip.box.bottom + SLACK));
                if (cut) problems.push(`${control} is clipped by ${clip.label}`);
            }
        }
        expect(problems, 'Controls must reflow at 320 by 640 CSS px with a 200% root font size').toEqual([]);
    } finally {
        await page.evaluate((previous) => {
            if (previous) document.documentElement.style.setProperty('font-size', previous);
            else document.documentElement.style.removeProperty('font-size');
        }, fontSize);
        if (viewport) await page.setViewportSize(viewport);
    }
}
