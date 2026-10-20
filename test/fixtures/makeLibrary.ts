/**
 * Generates a fixture photo library with Sharp, so no fixture binaries live in git.
 *
 * Usage: npx tsx test/fixtures/makeLibrary.ts <dir> [--extras]
 *
 * Writes landscape.jpg (red-dominant), portrait.png (green-dominant), and
 * square.webp. --extras adds landscape-edited.jpg (new, blue-dominant pixels),
 * landscape-rot6.jpg (landscape.jpg's bytes plus EXIF Orientation 6, so the
 * same pixels), and corrupt.jpg (a JPEG header Sharp can't decode).
 * The output is deterministic for a given Sharp version.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const BASIC_FIXTURES = ['landscape.jpg', 'portrait.png', 'square.webp'] as const;
export const EXTRA_FIXTURES = ['landscape-edited.jpg', 'landscape-rot6.jpg', 'corrupt.jpg'] as const;

export type Channel = 'red' | 'green' | 'blue';

type Pixel = (x: number, y: number, width: number, height: number) => [number, number, number];

function render(width: number, height: number, pixel: Pixel) {
    const data = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            data.set(pixel(x, y, width, height), (y * width + x) * 3);
        }
    }
    return sharp(data, { raw: { width, height, channels: 3 } });
}

// Gradients with a little texture, so every derivative size encodes differently.
const warm: Pixel = (x, y, w, h) => [170 + Math.round((x / w) * 60), 40 + Math.round((y / h) * 50), 30 + ((x ^ y) & 15)];
const cool: Pixel = (x, y, w, h) => { const [r, g, b] = warm(x, y, w, h); return [b, g, r]; };
const leafy: Pixel = (x, y, w, h) => [30 + Math.round((y / h) * 40), 150 + Math.round((x / w) * 70), 50 + ((x + y) & 15)];
const checker: Pixel = (x, y) => (((x >> 5) + (y >> 5)) % 2 === 0 ? [120, 60, 160] : [200, 180, 220]);

/** Insert an EXIF APP1 segment holding only Orientation, keeping the image data byte-identical. */
export function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('Not a JPEG');
    const tiff = Buffer.from([
        0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF header, IFD0 at offset 8
        0x00, 0x01, // one entry
        0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation, SHORT, 1 value
        0x00, 0x00, 0x00, 0x00, // no next IFD
    ]);
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const header = Buffer.from([0xff, 0xe1, 0x00, 0x00]);
    header.writeUInt16BE(payload.length + 2, 2);

    // Keep a JFIF APP0 segment first if there is one
    let offset = 2;
    if (jpeg[2] === 0xff && jpeg[3] === 0xe0) offset = 4 + jpeg.readUInt16BE(4);
    return Buffer.concat([jpeg.subarray(0, offset), header, payload, jpeg.subarray(offset)]);
}

/** The fixture files by name, in memory. */
export async function fixtureFiles({ extras = false }: { extras?: boolean } = {}): Promise<Map<string, Buffer>> {
    const landscape = await render(960, 640, warm).jpeg({ quality: 90 }).toBuffer();
    const files = new Map<string, Buffer>([
        ['landscape.jpg', landscape],
        ['portrait.png', await render(640, 960, leafy).png().toBuffer()],
        ['square.webp', await render(720, 720, checker).webp({ quality: 90 }).toBuffer()],
    ]);
    if (extras) {
        files.set('landscape-edited.jpg', await render(960, 640, cool).jpeg({ quality: 90 }).toBuffer());
        files.set('landscape-rot6.jpg', withExifOrientation(landscape, 6));
        files.set('corrupt.jpg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('corrupt fixture, not an image\n')]));
    }
    return files;
}

/** Write the fixtures into `dir`, creating it if needed. Returns the file names. */
export async function makeLibrary(dir: string, { extras = false }: { extras?: boolean } = {}): Promise<string[]> {
    fs.mkdirSync(dir, { recursive: true });
    const files = await fixtureFiles({ extras });
    for (const [name, data] of files) {
        fs.writeFileSync(path.join(dir, name), data);
    }
    return [...files.keys()];
}

/** The strongest channel of an image, which tells the fixture versions apart. */
export async function dominantChannel(image: Buffer): Promise<Channel> {
    const { channels } = await sharp(image).stats();
    const [red, green, blue] = channels.map((channel) => channel.mean);
    if (red >= green && red >= blue) return 'red';
    return green >= blue ? 'green' : 'blue';
}

function isMainModule(): boolean {
    const entry = process.argv[1];
    if (!entry) return false;
    try {
        return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (isMainModule()) {
    const args = process.argv.slice(2);
    const dirs = args.filter((arg) => !arg.startsWith('--'));
    const unknown = args.filter((arg) => arg.startsWith('--') && arg !== '--extras');
    if (dirs.length !== 1 || unknown.length > 0) {
        console.error('Usage: npx tsx test/fixtures/makeLibrary.ts <dir> [--extras]');
        process.exitCode = 2;
    } else {
        makeLibrary(path.resolve(dirs[0]), { extras: args.includes('--extras') })
            .then((names) => console.log(`Wrote ${names.join(', ')} to ${path.resolve(dirs[0])}`))
            .catch((error) => {
                console.error(error);
                process.exitCode = 1;
            });
    }
}
