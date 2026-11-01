// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss, { type AtRule, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

// A theme change under reduced motion starts no transitions (the v1.3.0 phone scroll regression): ThemeProvider puts
// data-theme-swap on <html> for the two frames a new theme lands in (components/ThemeContext.tsx), and app/globals.css
// turns transitions off under it. ThemeContext.test.tsx pins the attribute; this pins the rule, which no parity gate
// reads (e2e/themes/computed.ts has no transition-*), and e2e/shell/theme.spec.ts counts what a switch starts.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const SWAP = '[data-theme-swap] *';

/** Each rule whose selector list names the swap, with the media query it sits in ('' at the top level). */
function swapRules() {
    const found: { media: string; transition?: string; important?: boolean }[] = [];
    postcss.parse(read('app/globals.css'), { from: 'app/globals.css' }).walkRules((rule: Rule) => {
        if (!rule.selectors.some((selector) => selector.includes('data-theme-swap'))) return;
        const media = rule.parent?.type === 'atrule' ? (rule.parent as AtRule).params : '';
        const decl = rule.nodes.find((node) => node.type === 'decl' && node.prop === 'transition');
        found.push({ media, transition: decl?.type === 'decl' ? decl.value : undefined, important: decl?.type === 'decl' ? decl.important : undefined });
        expect(rule.selectors, 'the swap selector, exactly').toContain(SWAP);
    });
    return found;
}

describe('a theme swap under reduced motion', () => {
    it('turns every transition off under data-theme-swap, and only under reduced motion', () => {
        expect(swapRules()).toEqual([{ media: '(prefers-reduced-motion: reduce)', transition: 'none', important: true }]);
    });

    it('outranks the reduced-motion baseline it switches off', () => {
        // The baseline's `*` sets transition-duration: 0.01ms !important; the swap's `[data-theme-swap] *` is more
        // specific, so its !important `none` wins whatever the order. Both must stay !important for that.
        const css = read('app/globals.css');
        expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{[^}]*transition-duration: 0\.01ms !important;/);
    });

    it('names the attribute ThemeProvider sets', () => {
        const provider = read('components/ThemeContext.tsx');
        expect(provider).toContain("setAttribute('data-theme-swap', '')");
        expect(provider).toContain("removeAttribute('data-theme-swap')");
    });
});
