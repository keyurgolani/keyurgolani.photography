import { expect, type Locator } from '@playwright/test';
import { waitForHydration } from './hydration';

/** Absorbs subpixel layout, so a 44 px target never fails as 43.999 px. */
const EPSILON = 0.01;

/**
 * Contract rule 5: every element `targets` matches is at least `min` by `min`
 * CSS px by bounding box. axe's target-size rule stops at 24 px.
 */
export async function expectMinTargetSize(targets: Locator, min = 44): Promise<void> {
    await waitForHydration(targets.page());
    await targets.first().waitFor({ state: 'attached' });
    const small: string[] = [];
    for (const target of await targets.all()) {
        const box = await target.boundingBox();
        if (!box) small.push(`${target} is not rendered`);
        else if (box.width < min - EPSILON || box.height < min - EPSILON) {
            small.push(`${target} is ${box.width.toFixed(1)} by ${box.height.toFixed(1)}`);
        }
    }
    expect(small, `Targets must be at least ${min} by ${min} CSS px`).toEqual([]);
}
