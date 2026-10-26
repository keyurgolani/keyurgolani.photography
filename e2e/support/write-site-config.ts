/**
 * Writes a site config folder holding the stand-in About portrait:
 * `<dir>/about/portrait.jpg`, carrying EXIF with GPS and orientation 6, and
 * `<dir>/about/portrait.json`. The Playwright webServer command runs it before
 * the server starts. `--variant swapped` writes a second, different picture,
 * for the design screenshots of a swap.
 *
 *   npx tsx e2e/support/write-site-config.ts <dir> [--variant swapped]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { buildExif, withSegments } from '../../test/fixtures/exif';
import { STAND_IN_PORTRAIT } from './aboutPortrait';

type Palette = { ground: [string, string]; figure: string; glow: string };

const PALETTES: Record<string, Palette> = {
    default: { ground: ['#d9a35f', '#5c3a22'], figure: '#1d1a17', glow: '#fff1cf' },
    swapped: { ground: ['#7fa7b8', '#20384a'], figure: '#14181c', glow: '#e9f4f7' },
};

/** A head-and-shoulders silhouette on a lit gradient, drawn upright. */
function svg({ width, height }: { width: number; height: number }, { ground, figure, glow }: Palette): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 100 125">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="${ground[0]}"/><stop offset="1" stop-color="${ground[1]}"/></linearGradient>
    <radialGradient id="l" cx="0.5" cy="0.3" r="0.55"><stop offset="0" stop-color="${glow}" stop-opacity="0.85"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="100" height="125" fill="url(#g)"/>
  <rect width="100" height="125" fill="url(#l)"/>
  <ellipse cx="50" cy="42" rx="14" ry="17" fill="${figure}"/>
  <path d="M14 125 C16 88 32 72 50 72 C68 72 84 88 86 125 Z" fill="${figure}"/>
</svg>`;
}

const ascii = (value: string) => ({ type: 'ascii' as const, value });

async function main() {
    const [dir, flag, variant = 'default'] = process.argv.slice(2);
    if (!dir || (flag !== undefined && flag !== '--variant') || !(variant in PALETTES)) {
        throw new Error('Usage: write-site-config.ts <dir> [--variant default|swapped]');
    }
    // It replaces the portrait it finds, so it writes only under the temp folder, never a real site config folder.
    const target = fs.realpathSync(dir);
    if (!target.startsWith(`${fs.realpathSync(os.tmpdir())}${path.sep}`)) throw new Error(`Refusing to write a stand-in portrait outside ${os.tmpdir()}: ${dir}`);
    const { width, height, alt, focalPoint } = STAND_IN_PORTRAIT;
    // Stored on its side: orientation 6 turns it upright, so the stored pixels are height x width.
    const upright = await sharp(Buffer.from(svg({ width, height }, PALETTES[variant]))).png().toBuffer();
    const stored = await sharp(upright).rotate(-90).jpeg({ quality: 88 }).toBuffer();
    const thumbnail = await sharp({ create: { width: 16, height: 12, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
    const exif = buildExif({
        ifd0: { 0x010f: ascii('Stand-in Camera'), 0x0112: { type: 'short', value: [6] }, 0xc62f: ascii('STAND-IN-SERIAL') },
        exif: { 0x9003: ascii('2026:10:25 12:00:00') },
        gps: {
            0x0000: { type: 'byte', value: [2, 3, 0, 0] },
            0x0001: ascii('N'),
            0x0002: { type: 'rational', value: [[47, 1], [36, 1], [0, 1]] },
            0x0003: ascii('W'),
            0x0004: { type: 'rational', value: [[122, 1], [19, 1], [0, 1]] },
        },
        thumbnail,
    });
    const about = path.join(target, 'about');
    fs.mkdirSync(about, { recursive: true });
    for (const name of fs.readdirSync(about).filter((entry) => /^portrait\./.test(entry))) fs.rmSync(path.join(about, name));
    fs.writeFileSync(path.join(about, 'portrait.jpg'), withSegments(stored, [{ marker: 0xe1, payload: exif }]));
    fs.writeFileSync(path.join(about, 'portrait.json'), `${JSON.stringify({ alt, focalPoint }, null, 2)}\n`);
}

await main();
