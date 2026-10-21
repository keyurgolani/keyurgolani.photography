import { expect, type Locator, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './a11y';
import { expectFocusRingVisible, expectNotObscured, expectRingNotClipped } from './focus';
import { waitForHydration } from './hydration';
import { expectTabOrderMatchesVisualOrder } from './keyboard';
import { expectMinTargetSize } from './targets';

type AriaRole = Parameters<Page['getByRole']>[0];

export interface Surface {
    /** The photograph entries, whose Tab order must match their row-major visual order. */
    entries?: Locator;
    /** The other standalone controls, such as navigation links, toggles, and viewer buttons. */
    controls?: readonly Locator[];
    /** Fixed chrome that can paint over a focused element. */
    chrome?: readonly Locator[];
}

/**
 * What "passes the #1 automated and keyboard checks" runs on a route: axe,
 * entry order, 44 px targets, a visible and unclipped focus ring that `chrome`
 * doesn't obscure on every entry and control, and unique names.
 */
export async function checkSurface(page: Page, { entries, controls = [], chrome = [] }: Surface): Promise<void> {
    await waitForHydration(page);
    const groups = entries ? [entries, ...controls] : [...controls];
    // Entries can arrive after hydration, as the gallery's do once /api/photos answers, so axe waits for every group.
    for (const group of groups) await group.first().waitFor({ state: 'attached' });
    await expectNoA11yViolations(page);
    if (entries) await expectTabOrderMatchesVisualOrder(page, entries);
    for (const group of groups) await expectMinTargetSize(group, 44);
    for (const group of groups) {
        for (const element of await group.all()) {
            await expectFocusRingVisible(element);
            await expectRingNotClipped(element);
            await expectNotObscured(element, chrome);
        }
    }
    await expectUniqueNames(groups);
}

/** The accessible name the element itself carries, or '' when it has none of its own. */
async function ownName(element: Locator): Promise<string> {
    const snapshot: unknown = await element.ariaSnapshotJSON();
    const node = (Array.isArray(snapshot) ? snapshot[0] : undefined) as { role?: unknown; name?: unknown } | undefined;
    if (typeof node?.role !== 'string' || typeof node.name !== 'string' || !node.name.trim()) return '';
    // The snapshot flattens a generic wrapper away, so its first node can be a child's. Keep the name only if it's the element's.
    const owned = await element.page().getByRole(node.role as AriaRole, { name: node.name, exact: true }).and(element).count();
    return owned > 0 ? node.name : '';
}

/** Contract rule 2: every element has a name of its own, and no two share one. */
export async function expectUniqueNames(groups: readonly Locator[]): Promise<void> {
    const named: { label: string; name: string }[] = [];
    for (const group of groups) {
        await group.first().waitFor({ state: 'attached' });
        for (const element of await group.all()) named.push({ label: `${element}`, name: await ownName(element) });
    }
    const counts = new Map<string, number>();
    for (const { name } of named) if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    const problems = [
        ...named.filter(({ name }) => !name).map(({ label }) => `${label} has no name of its own`),
        ...[...counts].filter(([, count]) => count > 1).map(([name, count]) => `${count} elements share the name ${name}`),
    ];
    expect(problems, 'Every entry and control needs a unique name of its own').toEqual([]);
}
