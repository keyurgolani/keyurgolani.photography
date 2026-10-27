// @vitest-environment node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss, { type AtRule, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';
import { fitSizes } from '../viewerSizes';

const css = postcss.parse(fs.readFileSync(fileURLToPath(new URL('../StoryViewer.module.css', import.meta.url)), 'utf8'));

describe('fitSizes', () => {
    it('takes the header and the stage\'s padding off the height cap on a short wide screen, and keeps the share elsewhere', () => {
        expect(fitSizes(2400, 1600)).toBe(
            [
                '(min-width: 48rem) and (height < 40rem) and (min-aspect-ratio: 1875/1000) calc(150vh - 11.25rem)',
                '(min-width: 48rem) and (height < 40rem) 80vw',
                '(min-width: 48rem) and (min-aspect-ratio: 1875/1000) 150vh',
                '(min-width: 48rem) 80vw',
                '(min-aspect-ratio: 1500/1000) 150vh',
                '100vw',
            ].join(', '),
        );
    });

    it('splits wide screens where the CSS does: the title line\'s room starts at 40rem tall, where the offset rule stops', () => {
        const reserves = new Set<string>();
        css.walkAtRules('media', (rule: AtRule) => {
            rule.walkDecls('--viewer-reading-lead', () => {
                reserves.add(rule.params);
            });
        });
        expect([...reserves]).toEqual(['(min-width: 48rem) and (min-height: 40rem)']);
        expect(fitSizes(2400, 1600)).toContain('(min-width: 48rem) and (height < 40rem) ');
    });

    it('keeps one lead for every photograph, whatever its title and caption (9a\'s fixed stage), and a title line that holds it', () => {
        const leads = new Map<string, string>();
        const blocks = new Map<string, string>();
        css.walkAtRules('media', (rule: AtRule) => {
            rule.walkDecls('--viewer-reading-lead', (decl) => {
                leads.set((decl.parent as Rule).selector, decl.value.replace(/\s+/g, ' '));
            });
            rule.walkDecls('min-height', (decl) => {
                if ((decl.parent as Rule).selector === '.lead') blocks.set(rule.params, decl.value.replace(/\s+/g, ' '));
            });
        });
        // No rule reads what the reading area holds, so the stage can't change height from one photograph to the next.
        expect([...leads.keys()]).toEqual(['.viewer']);
        expect(css.toString()).not.toMatch(/:has\(\.(title|caption)/);
        expect(leads.get('.viewer')).toBe('calc(var(--viewer-reading-allowance) - (var(--viewer-stage-chrome) - 2 * var(--viewer-stage-pad)))');
        let allowance = '';
        css.walkDecls('--viewer-reading-allowance', (decl) => {
            allowance = decl.value.replace(/\s+/g, ' ');
        });
        // The allowance is the title's line and the caption's first one, with the rule, the padding, and the gaps.
        expect(allowance).toBe('calc(4px + var(--viewer-reading-pad) + 1.2 * var(--viewer-title-size) + 0.75rem + 1.5 * var(--gah-type-statement) + 0.5rem)');
        // Where the lead applies, the title and the caption sit in a block that tall, so what follows starts under the first screen.
        expect(blocks).toEqual(new Map([['(min-width: 48rem) and (min-height: 40rem)', 'calc(1.2 * var(--viewer-title-size) + 0.75rem + 1.5 * var(--gah-type-statement))']]));
    });

    it('takes off what the CSS box does there: the header and the stage chrome', () => {
        const rem = (property: string) => {
            let value: string | undefined;
            css.walkRules('.viewer', (rule) => {
                if (rule.parent?.type !== 'root') return;
                rule.walkDecls(property, (decl) => {
                    value = decl.value;
                });
            });
            expect(value, property).toMatch(/^\d+(\.\d+)?rem$/);
            return parseFloat(value!);
        };
        const offset = rem('--viewer-header') + rem('--viewer-stage-chrome');
        expect(fitSizes(2400, 1600)).toContain(`calc(150vh - ${offset * 1.5}rem)`);
    });
});
