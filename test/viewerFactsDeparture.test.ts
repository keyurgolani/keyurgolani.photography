import { describe, expect, it } from 'vitest';
import { cameraRowDeparture, type FactRow } from '../e2e/themes/viewerFacts';

// Dark parity's sanctioned departure on the Viewer's details list (#175, B8): the base's "Camera make" and "Camera"
// rows are one Camera row in the head, so the list has one row fewer. The walk leaves the base's Camera make row out;
// this is the check that nothing else in the list changed, every other row's label and value the same, in order.

const BASE: FactRow[] = [
    ['Camera make', 'Fixture Make'],
    ['Camera', 'Fixture Model'],
    ['Focal length', '35 mm'],
    ['Aperture', 'f/2.8'],
    ['Exposure', '1/250 s'],
    ['ISO', '200'],
];
const HEAD: FactRow[] = BASE.slice(1);

describe("the Viewer details list's camera row departure", () => {
    it('passes one row fewer when the base\'s first row is Camera make and every other row is the same, and records both lists', () => {
        const { failing, record } = cameraRowDeparture(BASE, HEAD);
        expect(failing).toEqual([]);
        expect(record).toEqual([
            'base rows (6): Camera make: Fixture Make | Camera: Fixture Model | Focal length: 35 mm | Aperture: f/2.8 | Exposure: 1/250 s | ISO: 200',
            'head rows (5): Camera: Fixture Model | Focal length: 35 mm | Aperture: f/2.8 | Exposure: 1/250 s | ISO: 200',
        ]);
    });

    it('fails any other row whose label or value differs, by its place', () => {
        const head = HEAD.map(([label, value]): FactRow => (label === 'ISO' ? [label, '100'] : label === 'Aperture' ? ['F-number', value] : [label, value]));
        expect(cameraRowDeparture(BASE, head).failing).toEqual([
            'row 3: "Aperture: f/2.8" in the base against "F-number: f/2.8" in the head',
            'row 5: "ISO: 200" in the base against "ISO: 100" in the head',
        ]);
    });

    it('fails a list whose rows were added or dropped besides the merge', () => {
        expect(cameraRowDeparture(BASE, HEAD.slice(0, -1)).failing).toEqual(['5 other rows in the base against 4 in the head', 'row 5: "ISO: 200" in the base against nothing in the head']);
        expect(cameraRowDeparture(BASE, [...HEAD, ['Lens', 'Fixture Lens']]).failing).toEqual(['5 other rows in the base against 6 in the head', 'row 6: nothing in the base against "Lens: Fixture Lens" in the head']);
    });

    it('fails unless the base has one Camera make row, first, where the walk leaves it out, and the head has none', () => {
        expect(cameraRowDeparture(HEAD, HEAD).failing).toEqual(['the base has 0 Camera make rows, not 1']);
        expect(cameraRowDeparture([BASE[1], BASE[0], ...BASE.slice(2)], HEAD).failing).toEqual(["the base's Camera make row is row 2, not the first, which the walk leaves out"]);
        expect(cameraRowDeparture(BASE, BASE).failing).toContain('the head still has a Camera make row');
    });
});
