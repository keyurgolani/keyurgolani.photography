import fs from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page } from '@playwright/test';
import { waitForHydration } from './hydration';

const GATE = '(hover: hover) and (pointer: fine)';

/**
 * Third-party stylesheets whose hover rules aren't the app's to gate. YARL
 * wraps its one hover rule in (hover: hover) alone.
 */
const THIRD_PARTY_CSS = ['yet-another-react-lightbox/styles.css', 'yet-another-react-lightbox/plugins/thumbnails.css'];

const squash = (selector: string) => selector.replace(/\s+/g, '');

let thirdParty: Set<string> | undefined;

/** The hover selectors the third-party stylesheets ship, whitespace removed. */
function thirdPartyHoverSelectors(): Set<string> {
    if (thirdParty) return thirdParty;
    const require = createRequire(import.meta.url);
    thirdParty = new Set(
        THIRD_PARTY_CSS.flatMap((file) =>
            [...fs.readFileSync(require.resolve(file), 'utf8').matchAll(/([^{}]+)\{/g)]
                .map(([, selector]) => selector.trim())
                .filter((selector) => selector.includes(':hover') && !selector.startsWith('@'))
                .map(squash),
        ),
    );
    return thirdParty;
}

/**
 * Contract rule 3: every app hover rule that matches markup on the page sits
 * inside @media (hover: hover) and (pointer: fine), so a tap never leaves a
 * hover style behind. Tailwind's hover: and group-hover: utilities count, and
 * so do app/globals.css and CSS modules.
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
    const known = thirdPartyHoverSelectors();
    const app = [...new Set(ungated)].filter((selector) => !known.has(squash(selector)));
    expect(app, `App hover rules that match markup here must sit inside @media ${GATE}`).toEqual([]);
}
