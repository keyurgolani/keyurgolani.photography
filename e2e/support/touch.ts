import type { Locator } from '@playwright/test';
import { waitForHydration } from './hydration';

/**
 * Contract rule 7: one tap activates, with no hover, long press, double tap,
 * or drag first. Taps the target once, which needs a hasTouch context, then
 * awaits `activated`, which should assert with web-first expects a state only
 * activation reaches. Chromium fires mouseover before the click on a tap, so
 * this can't catch a hover gate, only a first tap that does something other
 * than activate.
 */
export async function expectSingleTapActivates(target: Locator, activated: () => Promise<unknown>): Promise<void> {
    await waitForHydration(target.page());
    await target.tap();
    await activated();
}
