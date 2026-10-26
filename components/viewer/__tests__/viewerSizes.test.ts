// @vitest-environment node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss, { type AtRule } from 'postcss';
import { describe, expect, it } from 'vitest';
import { fitSizes } from '../viewerSizes';

const css = postcss.parse(fs.readFileSync(fileURLToPath(new URL('../StoryViewer.module.css', import.meta.url)), 'utf8'));

describe('fitSizes', () => {
    it('takes the header and the stage\'s padding off the height cap on a short wide screen, and keeps the share elsewhere', () => {
        expect(fitSizes(2400, 1600)).toBe(
            [
                '(min-width: 48rem) and (max-height: 39.99rem) and (min-aspect-ratio: 1875/1000) calc(150vh - 11.25rem)',
                '(min-width: 48rem) and (max-height: 39.99rem) 80vw',
                '(min-width: 48rem) and (min-aspect-ratio: 1875/1000) 150vh',
                '(min-width: 48rem) 80vw',
                '(min-aspect-ratio: 1500/1000) 150vh',
                '100vw',
            ].join(', '),
        );
    });

    it('splits wide screens where the CSS does: the title line\'s room starts at 40rem tall, where the offset rule stops', () => {
        const reserves: string[] = [];
        css.walkAtRules('media', (rule: AtRule) => {
            rule.walkDecls('--viewer-reading-lead', () => {
                reserves.push(rule.params);
            });
        });
        expect(reserves).toEqual(['(min-width: 48rem) and (min-height: 40rem)']);
        expect(fitSizes(2400, 1600)).toContain('(min-width: 48rem) and (max-height: 39.99rem) ');
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
