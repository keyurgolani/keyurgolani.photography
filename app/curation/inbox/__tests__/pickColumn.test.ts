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

    // A8's CI, run 42220768870: each checkbox's name is visually hidden text, absolutely positioned. With no positioned
    // ancestor its box hung from the page, at its place down the list's own scroll, so the window had room to scroll on
    // a wide screen, which #145 says it never does. The column it sits in is its containing block.
    it("holds its checkbox's hidden name, so the list's rows never give the window room to scroll", () => {
        expect(declarations('.pick').position).toBe('relative');
    });

    // A8's review: the item form has hidden text of its own (Archive's spoken reason line, #91's Confirm unavailable
    // note). On a wide screen both panels scroll on their own, so each is the containing block for whatever is
    // absolutely positioned inside it, and nothing in either gives the window room to scroll.
    it('makes each of the wide screen\'s two scrolling panels the containing block of what is positioned inside it', () => {
        const wide: Record<string, string>[] = [];
        CSS.walkAtRules('media', (media) => {
            if (media.params !== '(min-width: 768px)') return;
            media.walkRules((rule: Rule) => {
                if (rule.selectors.includes('.body > .list') && rule.selectors.includes('.detail > .fields')) {
                    const found: Record<string, string> = {};
                    rule.walkDecls((decl) => void (found[decl.prop] = decl.value));
                    wide.push(found);
                }
            });
        });
        expect(wide.some((found) => found['overflow-y'] === 'auto' && found.position === 'relative')).toBe(true);
    });

    it("puts the row's link in the second column, with next's padding", () => {
        const link = declarations('.pickRow > .item');
        expect(link['grid-column']).toBe('2');
        expect(link['padding-left']).toBeUndefined();
        expect(link.padding).toBeUndefined();
    });
});
