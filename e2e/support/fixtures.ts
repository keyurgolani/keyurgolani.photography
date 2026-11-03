/**
 * The photo fixtures, which test.ts paints onto the catalog Home's photographs
 * (setPhotoFixtures()), rendered with Sharp, which writes no metadata.
 */

type Rgb = readonly [number, number, number];

export interface PhotoFixture {
    /** The name setPhotoFixtures() takes. */
    name: string;
    width: number;
    height: number;
    /** One color for a solid fill, or two for a diagonal gradient. */
    colors: readonly [Rgb] | readonly [Rgb, Rgb];
}

const landscape = { width: 1200, height: 800 }; // 3:2
const portrait = { width: 800, height: 1200 }; // 2:3
const square = { width: 1000, height: 1000 }; // 1:1
const panorama = { width: 1800, height: 600 }; // 3:1

/** white is the bright fixture, and black the dark one. */
export const PHOTO_FIXTURES: readonly PhotoFixture[] = [
    { name: 'white', ...landscape, colors: [[255, 255, 255]] },
    { name: 'black', ...landscape, colors: [[0, 0, 0]] },
    { name: 'gray', ...square, colors: [[128, 128, 128]] },
    { name: 'photo-01', ...landscape, colors: [[32, 120, 140], [16, 32, 80]] },
    { name: 'photo-02', ...portrait, colors: [[240, 180, 60], [150, 60, 30]] },
    { name: 'photo-03', ...square, colors: [[90, 170, 90], [50, 70, 30]] },
    { name: 'photo-04', ...panorama, colors: [[150, 200, 240], [30, 60, 140]] },
    { name: 'photo-05', ...landscape, colors: [[230, 130, 150], [90, 40, 90]] },
    { name: 'photo-06', ...portrait, colors: [[220, 200, 160], [100, 70, 40]] },
    { name: 'photo-07', ...square, colors: [[170, 140, 220], [50, 40, 110]] },
    { name: 'photo-08', ...panorama, colors: [[250, 150, 70], [160, 30, 40]] },
    { name: 'photo-09', ...portrait, colors: [[170, 230, 200], [30, 90, 60]] },
];

const DEFAULT_PHOTO_NAMES: readonly string[] = PHOTO_FIXTURES.map((fixture) => fixture.name);

const byName = new Map(PHOTO_FIXTURES.map((fixture) => [fixture.name, fixture]));

/** The fixture called `name`, without `.jpg`. Throws for any other name. */
export function photoFixture(name: string): PhotoFixture {
    const fixture = byName.get(name);
    if (!fixture) {
        throw new Error(`No photo fixture named "${name}". Use one of ${DEFAULT_PHOTO_NAMES.join(', ')}, without .jpg.`);
    }
    return fixture;
}
