import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { PHOTO_FIXTURES, type PhotoFixture } from './fixtures';

function render({ width, height, colors }: PhotoFixture) {
    const [from, to] = colors;
    if (!to) {
        return sharp({ create: { width, height, channels: 3, background: { r: from[0], g: from[1], b: from[2] } } });
    }
    const data = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const t = (x / (width - 1) + y / (height - 1)) / 2;
            const offset = (y * width + x) * 3;
            for (let channel = 0; channel < 3; channel++) {
                data[offset + channel] = Math.round(from[channel] + (to[channel] - from[channel]) * t);
            }
        }
    }
    return sharp(data, { raw: { width, height, channels: 3 } });
}

/**
 * Writes the photo fixtures to a fresh temp directory and exports it as
 * E2E_FIXTURE_DIR, which the workers inherit. Sharp writes no metadata unless
 * asked, so the JPEGs carry no EXIF. The returned teardown deletes the
 * directory. playwright.config.ts removes the empty library it made.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-fixtures-'));
    process.env.E2E_FIXTURE_DIR = dir;
    await Promise.all(
        PHOTO_FIXTURES.map((fixture) => render(fixture).jpeg({ quality: 85 }).toFile(path.join(dir, `${fixture.name}.jpg`))),
    );

    return async () => {
        await fs.promises.rm(dir, { recursive: true, force: true });
    };
}
