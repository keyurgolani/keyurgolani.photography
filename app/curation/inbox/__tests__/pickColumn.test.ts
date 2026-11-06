// @vitest-environment node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

// #14's A8, from its CI (Dark parity): a row a bulk action can take has a 44 px column for its checkbox, beside the
// row's link. The column is sized by what's in it, and the link is placed in the second one with next's own padding,
// so with the checkbox's column taken out, as the parity gate takes out every element next never had, the link sits
// exactly where next's does.

const CSS = postcss.parse(fs.readFileSync(fileURLToPath(new URL('../../curator.module.css', import.meta.url)), 'utf8'));

/** Every declaration the stylesheet's top-level rules give `selector`, by property. */
function declarations(selector: string): Record<string, string> {
    const found: Record<string, string> = {};
    CSS.walkRules((rule: Rule) => {
        if (rule.parent?.type === 'root' && rule.selectors.includes(selector)) rule.walkDecls((decl) => void (found[decl.prop] = decl.value));
    });
    return found;
}

describe("the Inbox row's checkbox column", () => {
    it('is as wide as its checkbox, or its empty spacer, and no wider than what it holds', () => {
        expect(declarations('.pickRow')['grid-template-columns']).toBe('auto minmax(0, 1fr)');
        expect(declarations('.pick').width).toBe('44px');
        expect(declarations('.pickSpacer').width).toBe('44px');
    });

    it("puts the row's link in the second column, with next's padding", () => {
        const link = declarations('.pickRow > .item');
        expect(link['grid-column']).toBe('2');
        expect(link['padding-left']).toBeUndefined();
        expect(link.padding).toBeUndefined();
    });
});
