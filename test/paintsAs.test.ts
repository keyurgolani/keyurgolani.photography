import { afterEach, describe, expect, it } from 'vitest';
import { paintsAs, readPaint } from './helpers/parityWalk';

// A state the base has no screen for (dark-parity.spec.ts's NEW_STATES): its new parts are read in the head, the base
// elements they're made from are read in the base, and each named property must be the same. readPaint runs in the
// page (page.evaluate sends it alone), so here it runs in jsdom, on inline styles.

afterEach(() => {
    document.body.innerHTML = '';
});

describe('readPaint', () => {
    it('reads each named computed property of the first element each selector finds, and null where none is there', () => {
        document.body.innerHTML = '<p data-a="" style="color: rgb(1, 2, 3); border-top-color: rgb(4, 5, 6)">a</p><p data-a="" style="color: rgb(9, 9, 9)">b</p>';
        expect(
            readPaint([
                { selector: '[data-a]', properties: ['color', 'border-top-color'] },
                { selector: '[data-missing]', properties: ['color'] },
            ]),
        ).toEqual([{ color: 'rgb(1, 2, 3)', 'border-top-color': 'rgb(4, 5, 6)' }, null]);
    });
});

describe('paintsAs', () => {
    const properties = ['color', 'border-top-color', 'font-size'];
    const model = { color: 'rgb(246, 244, 238)', 'border-top-color': 'rgba(255, 255, 255, 0.38)', 'font-size': '14px' };

    it('passes when the new part paints every named property as the base element does', () => {
        expect(paintsAs('[data-new]', { ...model }, '[data-old]', model, properties)).toEqual([]);
    });

    it('names each property that differs, with both values', () => {
        expect(paintsAs('[data-new]', { ...model, color: 'rgb(255, 0, 0)', 'font-size': '15px' }, '[data-old]', model, properties)).toEqual([
            '[data-new] color: rgb(255, 0, 0), where the base\'s [data-old] has rgb(246, 244, 238)',
            '[data-new] font-size: 15px, where the base\'s [data-old] has 14px',
        ]);
    });

    it('fails when the new part, or the base element, isn\'t on the page, or a value was never read', () => {
        expect(paintsAs('[data-new]', null, '[data-old]', model, properties)).toEqual(['[data-new]: not in the head']);
        expect(paintsAs('[data-new]', model, '[data-old]', null, properties)).toEqual(["[data-old]: not in the base"]);
        expect(paintsAs('[data-new]', { color: model.color, 'font-size': '14px' }, '[data-old]', model, properties)).toEqual([
            "[data-new] border-top-color: not read, where the base's [data-old] has rgba(255, 255, 255, 0.38)",
        ]);
    });

    it('refuses an empty list of properties, which would pass anything', () => {
        expect(() => paintsAs('[data-new]', model, '[data-old]', model, [])).toThrow(/no properties/);
    });
});
