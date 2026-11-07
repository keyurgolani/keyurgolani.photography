import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Fails the first image `image` matches, as a broken file would, until `missing` shows. ResponsivePhoto retries a
 * failed AVIF file once with WebP before it reports a failure (#6, B8), so one error event only starts the retry: this
 * sends the error again, to whichever file the image picked next, until the screen shows its missing-image state. A
 * build without the retry shows it after the first.
 */
export async function failImage(page: Page, image: string, missing: Locator): Promise<void> {
    await expect
        .poll(async () => {
            await page.evaluate((selector) => document.querySelector(selector)?.dispatchEvent(new Event('error')), image);
            return missing.count();
        })
        .toBeGreaterThan(0);
}
