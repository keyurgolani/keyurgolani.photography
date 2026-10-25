import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { waitForHydration } from './hydration';

export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * Contract rule 12: every axe rule disabled for a third-party widget is
 * listed here once, with the reason and the issue that removes it. None yet.
 */
export const DISABLED_RULES: readonly { id: string; reason: string; removedBy: string }[] = [];

const BLOCKING = new Set(['serious', 'critical']);

export interface A11yOptions {
    /** A selector to limit the run to, for a page whose other parts another issue owns. */
    include?: string;
}

/** Runs axe with the WCAG 2.2 A and AA tags and fails on any serious or critical violation. */
export async function expectNoA11yViolations(page: Page, { include }: A11yOptions = {}): Promise<void> {
    await waitForHydration(page);
    let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
    if (include) builder = builder.include(include);
    if (DISABLED_RULES.length > 0) builder = builder.disableRules(DISABLED_RULES.map((rule) => rule.id));
    const { violations } = await builder.analyze();
    const blocking = violations
        .filter((violation) => BLOCKING.has(violation.impact ?? ''))
        .map((violation) => `${violation.id} (${violation.impact}): ${violation.help}, at ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`);
    expect(blocking, 'Serious or critical WCAG 2.2 A or AA violations').toEqual([]);
}
