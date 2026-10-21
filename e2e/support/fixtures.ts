/**
 * The photo fixtures. global-setup.ts writes each one as an EXIF-free JPEG,
 * and test.ts lists them from the intercepted /api/photos and serves the files.
 */

export const FIXTURE_CAPTION = 'Fixture Camera | 35mm f/1.8 1/200s ISO 100';

type Rgb = readonly [number, number, number];

export interface PhotoFixture {
    /** The file name without `.jpg`. */
    name: string;
    width: number;
    height: number;
    /** The caption its record carries, or '' for none. */
    caption: string;
    /** One color for a solid fill, or two for a diagonal gradient. */
    colors: readonly [Rgb] | readonly [Rgb, Rgb];
}

const landscape = { width: 1200, height: 800 }; // 3:2
const portrait = { width: 800, height: 1200 }; // 2:3
const square = { width: 1000, height: 1000 }; // 1:1
const panorama = { width: 1800, height: 600 }; // 3:1

/** In the order /api/photos lists them by default. white is the bright fixture, and half the records, white included, carry the caption. */
export const PHOTO_FIXTURES: readonly PhotoFixture[] = [
    { name: 'white', ...landscape, caption: FIXTURE_CAPTION, colors: [[255, 255, 255]] },
    { name: 'black', ...landscape, caption: '', colors: [[0, 0, 0]] },
    { name: 'gray', ...square, caption: FIXTURE_CAPTION, colors: [[128, 128, 128]] },
    { name: 'photo-01', ...landscape, caption: '', colors: [[32, 120, 140], [16, 32, 80]] },
    { name: 'photo-02', ...portrait, caption: FIXTURE_CAPTION, colors: [[240, 180, 60], [150, 60, 30]] },
    { name: 'photo-03', ...square, caption: '', colors: [[90, 170, 90], [50, 70, 30]] },
    { name: 'photo-04', ...panorama, caption: FIXTURE_CAPTION, colors: [[150, 200, 240], [30, 60, 140]] },
    { name: 'photo-05', ...landscape, caption: '', colors: [[230, 130, 150], [90, 40, 90]] },
    { name: 'photo-06', ...portrait, caption: FIXTURE_CAPTION, colors: [[220, 200, 160], [100, 70, 40]] },
    { name: 'photo-07', ...square, caption: '', colors: [[170, 140, 220], [50, 40, 110]] },
    { name: 'photo-08', ...panorama, caption: FIXTURE_CAPTION, colors: [[250, 150, 70], [160, 30, 40]] },
    { name: 'photo-09', ...portrait, caption: '', colors: [[170, 230, 200], [30, 90, 60]] },
];

export const DEFAULT_PHOTO_NAMES: readonly string[] = PHOTO_FIXTURES.map((fixture) => fixture.name);

const byName = new Map(PHOTO_FIXTURES.map((fixture) => [fixture.name, fixture]));

/** The fixture called `name`, without `.jpg`. Throws for any other name. */
export function photoFixture(name: string): PhotoFixture {
    const fixture = byName.get(name);
    if (!fixture) {
        throw new Error(`No photo fixture named "${name}". Use one of ${DEFAULT_PHOTO_NAMES.join(', ')}, without .jpg.`);
    }
    return fixture;
}

export function isPhotoFixture(name: string): boolean {
    return byName.has(name);
}

/** The directory global-setup.ts wrote the fixture files to. */
export function fixtureDir(): string {
    const dir = process.env.E2E_FIXTURE_DIR;
    if (!dir) {
        throw new Error('E2E_FIXTURE_DIR is unset. Run the suite with `npm run test:e2e`, so e2e/support/global-setup.ts writes the fixtures.');
    }
    return dir;
}
