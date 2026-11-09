import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { fillRequired, focusOf, GATE_STATUS, GATE_STATUS_TEXT, reveal } from './inbox-gate';
import { expect } from './test';

// The curator's other forms at the submit gate (e2e/curation-{publish,history,series}-gate.spec.ts): Publish, History
// and Series. Each spec holds a page's scripts back, presses every form on it before it hydrates, lets the scripts go,
// and then makes one press that posts. These are the steps they share, as e2e/curation-inbox-gate.spec.ts takes them.

/**
 * What the data root holds where a curator press writes: the working layer (`authored/`) and the catalog's revisions,
 * pointer, activations and candidates, by path and content. Diagnostics are left out: a check may note what it found.
 */
export function written(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const at = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(at);
            else if (entry.isFile()) out.push(`${path.relative(root, at)} ${createHash('sha256').update(fs.readFileSync(at)).digest('hex')}`);
        }
    };
    for (const dir of ['authored', 'catalog/active', 'catalog/revisions', 'catalog/activations', 'catalog/candidates']) walk(path.join(root, dir));
    return out.sort();
}

/** Every POST the page sends, and every response it gets with a 403, from now on, until `stop`. */
export function watchPosts(page: Page) {
    const posts: string[] = [];
    const refused: string[] = [];
    const onRequest = (request: { method(): string; url(): string }) => {
        if (request.method() === 'POST') posts.push(request.url());
    };
    const onResponse = (response: { status(): number; url(): string }) => {
        if (response.status() === 403) refused.push(response.url());
    };
    page.on('request', onRequest);
    page.on('response', onResponse);
    return {
        posts,
        refused,
        clear: () => {
            posts.length = 0;
            refused.length = 0;
        },
        stop: () => {
            page.off('request', onRequest);
            page.off('response', onResponse);
        },
    };
}

/**
 * Presses every form in `forms` before the page has hydrated, as the Inbox gate spec does: each submit button (one
 * that's only aria-disabled too, which a curator can still press), Enter in its first text field, and requestSubmit.
 * Each one must post nothing, land on no 403, leave the page where it was and the data root as it was, and keep the
 * focus where the press left it. The first drop must show the status. Returns the labels it covered.
 */
export async function pressEveryFormEarly(page: Page, { name, forms, root, watch }: { name: string; forms: Locator; root: string; watch: ReturnType<typeof watchPosts> }): Promise<string[]> {
    const covered: string[] = [];
    let said = false;
    const dropped = async (label: string, act: () => Promise<void>, focus: Locator | null) => {
        const url = page.url();
        const before = written(root);
        const focusBefore = await focusOf(page);
        await act();
        await page.waitForTimeout(400);
        expect(watch.posts, `${label}: nothing posted`).toEqual([]);
        expect(watch.refused, `${label}: nothing landed on a 403`).toEqual([]);
        expect(page.url(), `${label}: the page stays where it was`).toBe(url);
        expect(written(root), `${label}: nothing written`).toEqual(before);
        if (focus) await expect(focus, `${label}: the focus stays`).toBeFocused();
        else expect(await focusOf(page), `${label}: the focus stays`).toBe(focusBefore);
        if (!said) {
            // The first drop says the page is still loading, in a status that's read out, and shows it.
            await expect(page.getByRole('status').filter({ hasText: GATE_STATUS_TEXT }), `${name}: the status after a dropped press`).toBeVisible();
            await expect(page.locator(GATE_STATUS)).toHaveCount(1);
            said = true;
        }
        covered.push(label);
    };
    const count = await forms.count();
    expect(count, `${name}: the forms are there`).toBeGreaterThan(0);
    for (let index = 0; index < count; index++) {
        const form = forms.nth(index);
        const buttons = form.locator('button[type="submit"]');
        for (let at = 0; at < (await buttons.count()); at++) {
            const button = buttons.nth(at);
            await reveal(button);
            await fillRequired(form);
            const label = `${name}: press ${((await button.textContent()) ?? '').replace(/\s+/g, ' ').trim()}`;
            // Playwright won't press an aria-disabled button without force; a curator can, and before hydration nothing stops it.
            const off = (await button.getAttribute('aria-disabled')) === 'true';
            await dropped(label, () => button.click({ timeout: 5000, force: off }), button);
        }
        const field = form.locator('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"])').first();
        if (await field.count()) {
            await reveal(field);
            await fillRequired(form);
            await field.focus();
            await dropped(`${name}: Enter in ${(await field.getAttribute('name')) ?? 'a field'}, form ${index + 1}`, () => field.press('Enter'), field);
        }
        await fillRequired(form);
        await dropped(`${name}: requestSubmit, form ${index + 1}`, () => form.evaluate((element) => (element as HTMLFormElement).requestSubmit()), null);
    }
    return covered;
}

/** After the scripts are let go: nothing a dropped press did goes out while the page hydrates, and the status goes. */
export async function nothingOnceReady(page: Page, { name, root, before, watch }: { name: string; root: string; before: string[]; watch: ReturnType<typeof watchPosts> }) {
    await page.waitForTimeout(400);
    expect(watch.posts, `${name}: nothing posted while the page hydrated`).toEqual([]);
    expect(watch.refused, `${name}: nothing landed on a 403 while the page hydrated`).toEqual([]);
    expect(written(root), `${name}: nothing written while the page hydrated`).toEqual(before);
    await expect(page.locator(GATE_STATUS), `${name}: the status once ready`).toHaveCount(0);
}
