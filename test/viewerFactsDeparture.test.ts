import { describe, expect, it } from 'vitest';
import { technicalFacts } from '../components/viewer/viewerLabels';
import { cameraRowDeparture, type FactRow } from '../e2e/themes/viewerFacts';
import { DEFAULT_TECHNICAL } from '../lib/catalog/testing';

// Dark parity's sanctioned departure on the Viewer's details list (#175, B8). The base's "Camera make" and "Camera"
// rows are one Camera row in the head, so the list has one row fewer, and three values gain the units #175 asks for.
// The walk leaves the base's Camera make row out; this is the check that nothing else in the list changed: the three
// unit rows hold the exact strings the coordinator ruled, and every other row is byte-equal, in order.

/** The parity base's rows (be35250a), as its Viewer prints the fixture's camera facts. */
const BASE: FactRow[] = [
    ['Camera make', 'Fixture Make'],
    ['Camera', 'Fixture Model'],
    ['Focal length', '35'],
    ['Aperture', '2.8'],
    ['Exposure', '1/250'],
    ['ISO', '200'],
];
/** The head's rows, as B8's Viewer prints the same facts. */
const HEAD: FactRow[] = [
    ['Camera', 'Fixture Model'],
    ['Focal length', '35 mm'],
    ['Aperture', 'f/2.8'],
    ['Exposure', '1/250 s'],
    ['ISO', '200'],
];

/** HEAD with one row's value changed. */
const headWith = (label: string, value: string): FactRow[] => HEAD.map(([name, text]): FactRow => [name, name === label ? value : text]);
const departure = (label: string, base: string, head: string) => `, where #175's departure is "${label}: ${base}" against "${label}: ${head}"`;

describe("the Viewer details list's departure", () => {
    it("passes the real rows: Camera make merged, the three unit rows exactly as ruled, and records both lists and each unit row", () => {
        const { failing, record } = cameraRowDeparture(BASE, HEAD);
        expect(failing).toEqual([]);
        expect(record).toEqual([
            'base rows (6): Camera make: Fixture Make | Camera: Fixture Model | Focal length: 35 | Aperture: 2.8 | Exposure: 1/250 | ISO: 200',
            'head rows (5): Camera: Fixture Model | Focal length: 35 mm | Aperture: f/2.8 | Exposure: 1/250 s | ISO: 200',
            'Focal length: "35" in the base, "35 mm" in the head',
            'Aperture: "2.8" in the base, "f/2.8" in the head',
            'Exposure: "1/250" in the base, "1/250 s" in the head',
        ]);
    });

    it("pins the strings the head's formatter gives the fixture's facts, though the gate never calls it", () => {
        expect(technicalFacts(DEFAULT_TECHNICAL).map(({ label, value }): FactRow => [label, value])).toEqual(HEAD);
    });

    it('fails any other row whose label or value differs, by its place', () => {
        const head = headWith('ISO', '100').map(([label, value]): FactRow => [label, label === 'Camera' ? 'Fixture Make Fixture Model' : value]);
        expect(cameraRowDeparture(BASE, head).failing).toEqual([
            'row 1: "Camera: Fixture Model" in the base against "Camera: Fixture Make Fixture Model" in the head',
            'row 5: "ISO: 200" in the base against "ISO: 100" in the head',
        ]);
    });

    it('fails a list whose rows were added or dropped besides the merge', () => {
        expect(cameraRowDeparture(BASE, HEAD.slice(0, -1)).failing).toEqual(['5 other rows in the base against 4 in the head', 'row 5: "ISO: 200" in the base against nothing in the head']);
        expect(cameraRowDeparture(BASE, [...HEAD, ['Lens', 'Fixture Lens']]).failing).toEqual(['5 other rows in the base against 6 in the head', 'row 6: nothing in the base against "Lens: Fixture Lens" in the head']);
    });

    it('fails unless the base has one Camera make row, first, where the walk leaves it out, and the head has none', () => {
        expect(cameraRowDeparture(BASE.slice(1), HEAD).failing).toEqual(['the base has 0 Camera make rows, not 1']);
        expect(cameraRowDeparture([BASE[1], BASE[0], ...BASE.slice(2)], HEAD).failing).toEqual(["the base's Camera make row is row 2, not the first, which the walk leaves out"]);
        expect(cameraRowDeparture(BASE, [BASE[0], ...HEAD]).failing).toContain('the head still has a Camera make row');
    });

    describe('mutants of the unit rows, each caught', () => {
        it('a prefix match: "1/2500 s" is not "1/250 s"', () => {
            expect(cameraRowDeparture(BASE, headWith('Exposure', '1/2500 s')).failing).toEqual([`row 4: "Exposure: 1/250" in the base against "Exposure: 1/2500 s" in the head${departure('Exposure', '1/250', '1/250 s')}`]);
        });

        it('a number match: "1/2 s" is not "1/250 s"', () => {
            expect(cameraRowDeparture(BASE, headWith('Exposure', '1/2 s')).failing).toEqual([`row 4: "Exposure: 1/250" in the base against "Exposure: 1/2 s" in the head${departure('Exposure', '1/250', '1/250 s')}`]);
        });

        it('a unit on any other row, or the wrong unit on a unit row', () => {
            expect(cameraRowDeparture(BASE, headWith('ISO', '200 s')).failing).toEqual(['row 5: "ISO: 200" in the base against "ISO: 200 s" in the head']);
            expect(cameraRowDeparture(BASE, headWith('Aperture', '2.8 mm')).failing).toEqual([`row 3: "Aperture: 2.8" in the base against "Aperture: 2.8 mm" in the head${departure('Aperture', '2.8', 'f/2.8')}`]);
        });

        it("a self-comparison: a base that already reads as the head's formatter gives fails every unit row", () => {
            const formatted: FactRow[] = [BASE[0], ...technicalFacts(DEFAULT_TECHNICAL).map(({ label, value }): FactRow => [label, value])];
            expect(cameraRowDeparture(formatted, HEAD).failing).toEqual([
                `row 2: "Focal length: 35 mm" in the base against "Focal length: 35 mm" in the head${departure('Focal length', '35', '35 mm')}`,
                `row 3: "Aperture: f/2.8" in the base against "Aperture: f/2.8" in the head${departure('Aperture', '2.8', 'f/2.8')}`,
                `row 4: "Exposure: 1/250 s" in the base against "Exposure: 1/250 s" in the head${departure('Exposure', '1/250', '1/250 s')}`,
            ]);
        });

        it('exact bytes: no space, or a no-break space, is not U+0020', () => {
            for (const value of ['1/250s', '1/250\u00a0s', '1/250\u202fs']) {
                expect(cameraRowDeparture(BASE, headWith('Exposure', value)).failing, JSON.stringify(value)).toEqual([`row 4: "Exposure: 1/250" in the base against "Exposure: ${value}" in the head${departure('Exposure', '1/250', '1/250 s')}`]);
            }
        });

        it('a stale sanction: a unit row in neither build fails', () => {
            const without = (rows: FactRow[]) => rows.filter(([label]) => label !== 'Exposure');
            expect(cameraRowDeparture(without(BASE), without(HEAD)).failing).toEqual(['the base has 0 Exposure rows, not 1', 'the head has 0 Exposure rows, not 1']);
        });

        it('a unit row repeated fails', () => {
            expect(cameraRowDeparture(BASE, [...HEAD.slice(0, 4), ['Exposure', '1/250 s'], ...HEAD.slice(4)]).failing).toContain('the head has 2 Exposure rows, not 1');
        });

        it('order and label: two unit rows swapped, or one renamed', () => {
            const swapped: FactRow[] = [HEAD[0], HEAD[2], HEAD[1], HEAD[3], HEAD[4]];
            expect(cameraRowDeparture(BASE, swapped).failing).toEqual([
                `row 2: "Focal length: 35" in the base against "Aperture: f/2.8" in the head${departure('Focal length', '35', '35 mm')}`,
                `row 3: "Aperture: 2.8" in the base against "Focal length: 35 mm" in the head${departure('Aperture', '2.8', 'f/2.8')}`,
            ]);
            const renamed = HEAD.map(([label, value]): FactRow => [label === 'Exposure' ? 'Shutter' : label, value]);
            expect(cameraRowDeparture(BASE, renamed).failing).toEqual(['the head has 0 Exposure rows, not 1', `row 4: "Exposure: 1/250" in the base against "Shutter: 1/250 s" in the head${departure('Exposure', '1/250', '1/250 s')}`]);
        });
    });
});
