import { expect, type Page } from '@playwright/test';
import { waitForHydration } from './hydration';

const GATE = '(hover: hover) and (pointer: fine)';

/**
 * Contract rule 3: every app hover rule that matches markup on the page sits
 * inside @media (hover: hover) and (pointer: fine), so a tap never leaves a
 * hover style behind. Tailwind's hover: and group-hover: utilities count, and
 * so do app/globals.css and CSS modules. The site ships no third-party
 * stylesheet since #13's slice E removed the lightbox, so every rule counts.
 */
export async function expectHoverRulesGated(page: Page): Promise<void> {
    await waitForHydration(page);
    const ungated = await page.evaluate((gate) => {
        const squashed = gate.replace(/\s+/g, '');
        // Splits a selector list on its top-level commas
        const split = (list: string) => {
            const parts: string[] = [];
            let depth = 0;
            let start = 0;
            for (let i = 0; i < list.length; i++) {
                const c = list[i];
                if (c === '(' || c === '[') depth++;
                else if (c === ')' || c === ']') depth--;
                else if (c === ',' && depth === 0) {
                    parts.push(list.slice(start, i));
                    start = i + 1;
                }
            }
            return [...parts, list.slice(start)];
        };
        // The :hover pseudo-class, not the escaped \:hover inside a class name such as Tailwind's dark\:hover\:shadow-lg
        const hover = /(?<!\\):hover/g;
        // A hover selector matches markup when the page has an element it would style once hovered
        const matchesMarkup = (list: string) => split(list).some((selector) => {
            if (!selector.match(hover)) return false;
            const base = selector.replace(hover, '').replace(/::?(before|after|placeholder|marker|selection|backdrop|first-line|first-letter)\b/g, '').trim();
            try {
                return document.querySelector(base || '*') !== null;
            } catch {
                return false;
            }
        });
        const found: string[] = [];
        const visit = (rules: CSSRuleList, gated: boolean) => {
            for (const rule of Array.from(rules)) {
                if (rule instanceof CSSMediaRule) {
                    visit(rule.cssRules, gated || rule.media.mediaText.replace(/\s+/g, '').includes(squashed));
                } else if (rule instanceof CSSStyleRule) {
                    if (!gated && matchesMarkup(rule.selectorText)) found.push(rule.selectorText);
                    if (rule.cssRules.length > 0) visit(rule.cssRules, gated);
                } else if (rule instanceof CSSGroupingRule) {
                    visit(rule.cssRules, gated);
                }
            }
        };
        for (const sheet of Array.from(document.styleSheets)) {
            let rules: CSSRuleList;
            try {
                rules = sheet.cssRules;
            } catch {
                continue; // a cross-origin sheet, which can't be the app's
            }
            visit(rules, false);
        }
        return found;
    }, GATE);
    expect([...new Set(ungated)], `App hover rules that match markup here must sit inside @media ${GATE}`).toEqual([]);
}
