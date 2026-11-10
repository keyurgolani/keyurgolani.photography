import type { Page } from '@playwright/test';
import { installAnnouncerLog, readAnnouncerLog, type AnnouncerStep } from '../../test/helpers/announcerLog';

export { describeLog, spokenOf, type AnnouncerStep } from '../../test/helpers/announcerLog';

let count = 0;

/**
 * Starts an announcer log on the page now and on every document it loads from now on, before any script runs, so a
 * Back that loads a new document is covered too. The reader reads the current document's log.
 */
export async function recordAnnouncer(page: Page): Promise<() => Promise<AnnouncerStep[]>> {
    const key = `announcer-${++count}`;
    await page.addInitScript(installAnnouncerLog, key);
    await page.evaluate(installAnnouncerLog, key);
    return () => page.evaluate(readAnnouncerLog, key);
}
