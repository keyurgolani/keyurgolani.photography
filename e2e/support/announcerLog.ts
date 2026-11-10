import type { Page } from '@playwright/test';
import { installAnnouncerLog, installTitleTrace, readAnnouncerLog, readTitleTrace, type AnnouncerStep, type TitleTraceEntry } from '../../test/helpers/announcerLog';

export { describeLog, describeTrace, nextChangeVerdict, readOf, shownHolding, spokenOf, type AnnouncerStep, type TitleTraceEntry } from '../../test/helpers/announcerLog';

let count = 0;

/**
 * Starts an announcer log on the page now and on every document it loads from now on, before any script runs, so a
 * Back that loads a new document is covered too. The reader reads the current document's log.
 */
export async function recordAnnouncer(page: Page, { titles = false }: { titles?: boolean } = {}): Promise<() => Promise<AnnouncerStep[]>> {
    const key = `announcer-${++count}`;
    await page.addInitScript(installAnnouncerLog, { key, titles });
    await page.evaluate(installAnnouncerLog, { key, titles });
    return () => page.evaluate(readAnnouncerLog, key);
}

/**
 * Starts a title trace (#258) on every document the page loads from now on, before any script runs. Call it before
 * the first goto. The reader reads the current document's trace.
 */
export async function traceTitles(page: Page): Promise<() => Promise<TitleTraceEntry[]>> {
    const key = `titles-${++count}`;
    await page.addInitScript(installTitleTrace, key);
    return () => page.evaluate(readTitleTrace, key);
}
