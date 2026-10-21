import { expect, type Locator, type Page } from '@playwright/test';
import { waitForHydration } from './hydration';

/** Entries whose top edges sit within this many px of a row's first entry share that row. */
const ROW_TOLERANCE = 8;

/**
 * Contract rule 6: DOM order equals row-major visual order (top edge, then
 * left edge), and Tab moves through the entries in DOM order.
 */
export async function expectTabOrderMatchesVisualOrder(page: Page, entries: Locator): Promise<void> {
    await waitForHydration(page);
    await entries.first().waitFor({ state: 'attached' });
    const count = await entries.count();
    const domOrder = Array.from({ length: count }, (_, index) => index);

    const visualOrder = await entries.evaluateAll((elements, tolerance) => {
        const items = elements.map((el, index) => {
            const { top, left } = el.getBoundingClientRect();
            return { index, top, left };
        });
        items.sort((a, b) => a.top - b.top || a.left - b.left);
        const rows: (typeof items)[] = [];
        for (const item of items) {
            const row = rows[rows.length - 1];
            if (row && item.top - row[0].top <= tolerance) row.push(item);
            else rows.push([item]);
        }
        return rows.flatMap((row) => row.sort((a, b) => a.left - b.left).map((item) => item.index));
    }, ROW_TOLERANCE);
    expect(visualOrder, `Row-major visual order of ${entries} must equal DOM order`).toEqual(domOrder);

    const focusedIndex = () => entries.evaluateAll((elements) => elements.findIndex((el) => el.contains(document.activeElement)));
    await entries.first().focus();
    const tabOrder = [await focusedIndex()];
    for (let press = 0; press < count * 5 + 20 && tabOrder[tabOrder.length - 1] !== count - 1; press++) {
        await page.keyboard.press('Tab');
        const index = await focusedIndex();
        if (index !== -1 && index !== tabOrder[tabOrder.length - 1]) tabOrder.push(index);
    }
    expect(tabOrder, `Tab order through ${entries} must equal DOM order`).toEqual(domOrder);
}

/**
 * Presses Tab from page load until focus lands on or inside `target`, and
 * fails if that takes more than `limit` presses. Call it before anything else
 * moves focus.
 */
export async function expectReachableWithin(page: Page, target: Locator, limit: number): Promise<void> {
    await waitForHydration(page);
    await target.waitFor({ state: 'attached' });
    const untouched = await page.evaluate(() => document.activeElement === null || document.activeElement === document.body);
    expect(untouched, 'expectReachableWithin counts Tab presses from page load, so nothing may have focus yet').toBe(true);

    const path: string[] = [];
    let reachedAt = 0;
    for (let press = 1; press <= limit && !reachedAt; press++) {
        await page.keyboard.press('Tab');
        const step = await target.evaluate((el) => {
            const active = document.activeElement;
            if (!active || active === document.body) return { inside: false, label: 'body' };
            const name = active.getAttribute('aria-label') ?? active.textContent?.trim().slice(0, 30);
            return { inside: el.contains(active), label: active.tagName.toLowerCase() + (name ? ` "${name}"` : '') };
        });
        if (step.inside) reachedAt = press;
        else path.push(step.label);
    }
    expect(reachedAt, `${target} must be reachable within ${limit} Tab presses, but focus went to ${path.join(', then ')}`).toBeGreaterThan(0);
}
