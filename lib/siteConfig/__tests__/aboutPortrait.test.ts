// @vitest-environment node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertOutsideRepository } from '../../../test/helpers/tempDataRoot';
import { checkAboutPortrait, PORTRAIT_LIMITS, PORTRAIT_TOKEN_RE, portraitToken, readAboutPortrait, resetAboutPortraitReader, sniffFormat } from '../aboutPortrait';
import { SITE_CONFIG_ENV, siteConfigDir } from '../dir';

let root: string;
let logger: { log: (line: unknown) => void; warn: (line: unknown) => void };
/** Every line logged, in order, and the warnings alone. */
let logged: string[];
let warned: string[];

const about = (...parts: string[]) => path.join(root, 'about', ...parts);
const lines = () => logged;
const warnings = () => warned;
const read = () => readAboutPortrait({ logger });

async function jpeg(width = 120, height = 150, color = { r: 180, g: 120, b: 60 }): Promise<Buffer> {
    return sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();
}

async function png(width = 120, height = 150): Promise<Buffer> {
    return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
}

/** A PNG with only a signature and an IHDR claiming `width` x `height`, so its size is checked without making one that big. */
function pngHeader(width: number, height: number): Buffer {
    const chunk = (type: string, data: Buffer) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body));
        return Buffer.concat([length, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.set([8, 2, 0, 0, 0], 8);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(0))), chunk('IEND', Buffer.alloc(0))]);
}

function put(name: string, data: Buffer | string): void {
    fs.mkdirSync(about(), { recursive: true });
    fs.writeFileSync(about(name), data);
}

/** Give a rewritten file a new mtime, as a copy from another machine would, since a test can rewrite inside one clock tick. */
function bump(name: string, seconds = 10): void {
    const time = new Date(Date.now() + seconds * 1000);
    fs.utimesSync(about(name), time, time);
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'site-config-'));
    assertOutsideRepository(root);
    vi.stubEnv(SITE_CONFIG_ENV, root);
    resetAboutPortraitReader();
    logged = [];
    warned = [];
    logger = {
        log: (line) => void logged.push(String(line)),
        warn: (line) => {
            logged.push(String(line));
            warned.push(String(line));
        },
    };
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
});

describe('siteConfigDir', () => {
    it('is PHOTOGRAPHY_SITE_CONFIG_DIR, or site-config under the working directory', () => {
        expect(siteConfigDir()).toBe(path.resolve(root));
        vi.stubEnv(SITE_CONFIG_ENV, '');
        expect(siteConfigDir()).toBe(path.join(process.cwd(), 'site-config'));
    });
});

describe('sniffFormat', () => {
    it('knows JPEG, PNG, and WebP by their magic bytes, and nothing else', async () => {
        expect(sniffFormat(await jpeg())).toBe('jpeg');
        expect(sniffFormat(await png())).toBe('png');
        expect(sniffFormat(await sharp(await png()).webp().toBuffer())).toBe('webp');
        expect(sniffFormat(Buffer.from('GIF89a'))).toBeNull();
        expect(sniffFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
        expect(sniffFormat(Buffer.alloc(0))).toBeNull();
    });
});

describe('readAboutPortrait', () => {
    it('reads about/portrait.jpg with the alt and focal point from portrait.json', async () => {
        put('portrait.jpg', await jpeg(120, 150));
        put('portrait.json', JSON.stringify({ alt: '  The artist on a ridge  ', focalPoint: { x: 40, y: 25 } }));
        const result = await read();
        expect(result).toMatchObject({ state: 'ready', file: 'about/portrait.jpg', format: 'jpeg', width: 120, height: 150, alt: 'The artist on a ridge', focalPoint: { x: 40, y: 25 } });
        if (result.state !== 'ready') return;
        expect(result.token).toMatch(PORTRAIT_TOKEN_RE);
        expect(result.token).toBe(portraitToken(result.sha256));
        expect(lines()).toEqual([`[about] About shows about/portrait.jpg, 120 x 150 px, sha256 ${result.state === 'ready' ? result.sha256.slice(0, 12) : ''}.`]);
    });

    it.each(['portrait.jpeg', 'portrait.png', 'portrait.webp'])('reads %s', async (name) => {
        const format = name.endsWith('.png') ? 'png' : name.endsWith('.webp') ? 'webp' : 'jpeg';
        put(name, await sharp(await png(90, 60)).toFormat(format).toBuffer());
        expect(await read()).toMatchObject({ state: 'ready', file: `about/${name}`, format, width: 90, height: 60, alt: null, focalPoint: null });
    });

    it('reports the upright size of a file stored on its side', async () => {
        put('portrait.jpg', await sharp(await jpeg(150, 120)).withMetadata({ orientation: 6 }).jpeg().toBuffer());
        expect(await read()).toMatchObject({ state: 'ready', width: 120, height: 150 });
    });

    it('keys the URL on the bytes, not the file: touching it keeps the token, new pixels change it', async () => {
        put('portrait.jpg', await jpeg());
        const first = await read();
        bump('portrait.jpg', 30);
        const touched = await read();
        put('portrait.jpg', await jpeg(120, 150, { r: 20, g: 90, b: 160 }));
        bump('portrait.jpg', 60);
        const swapped = await read();
        expect(first.state === 'ready' && touched.state === 'ready' && swapped.state === 'ready').toBe(true);
        if (first.state !== 'ready' || touched.state !== 'ready' || swapped.state !== 'ready') return;
        expect(touched.token).toBe(first.token);
        expect(swapped.token).not.toBe(first.token);
    });

    it('picks a swapped file up on the next call, with no restart, and reads nothing while nothing changed', async () => {
        put('portrait.jpg', await jpeg());
        const first = await read();
        const open = vi.spyOn(fs.promises, 'open');
        expect(await read()).toBe(first);
        expect(open).not.toHaveBeenCalled();
        fs.rmSync(about('portrait.jpg'));
        put('portrait.png', await png(200, 100));
        const swapped = await read();
        expect(swapped).toMatchObject({ state: 'ready', file: 'about/portrait.png', width: 200, height: 100 });
        expect(open).toHaveBeenCalled();
        expect(lines()).toHaveLength(2);
        expect(lines()[0]).toMatch(/^\[about\] About shows about\/portrait\.jpg, 120 x 150 px, sha256 [0-9a-f]{12}\.$/);
        expect(lines()[1]).toMatch(/^\[about\] About shows about\/portrait\.png, 200 x 100 px, sha256 [0-9a-f]{12}\.$/);
    });

    it('reads a changed file once for a burst of requests, so a swap never decodes it per visitor', async () => {
        put('portrait.jpg', await jpeg());
        const open = vi.spyOn(fs.promises, 'open');
        const results = await Promise.all(Array.from({ length: 6 }, () => read()));
        expect(new Set(results).size).toBe(1);
        expect(open.mock.calls.filter(([file]) => String(file).endsWith('portrait.jpg'))).toHaveLength(1);
    });

    it('logs a swap to a file with the same name and size, by its hash', async () => {
        put('portrait.jpg', await jpeg());
        await read();
        put('portrait.jpg', await jpeg(120, 150, { r: 20, g: 90, b: 160 }));
        bump('portrait.jpg');
        await read();
        expect(lines()).toHaveLength(2);
        expect(lines()[0]).not.toBe(lines()[1]);
    });

    it('rereads portrait.json when it changes, without rereading a portrait that did not', async () => {
        put('portrait.jpg', await jpeg());
        expect(await read()).toMatchObject({ alt: null });
        put('portrait.json', JSON.stringify({ alt: 'New alt' }));
        expect(await read()).toMatchObject({ state: 'ready', alt: 'New alt', focalPoint: null });
    });

    it('takes a PNG copied in place once its last bytes land, under a new token', async () => {
        const whole = await png(400, 500);
        put('portrait.png', whole.subarray(0, whole.length - 12));
        expect(await read()).toMatchObject({ state: 'none' });
        fs.appendFileSync(about('portrait.png'), whole.subarray(whole.length - 12));
        expect(await read()).toMatchObject({ state: 'ready', width: 400, height: 500, sha256: createHash('sha256').update(whole).digest('hex') });
    });

    it("takes a JPEG with data after its end marker, as a phone's motion photo has", async () => {
        put('portrait.jpg', Buffer.concat([await jpeg(), Buffer.from('ftypmp42 a trailing video')]));
        expect(await read()).toMatchObject({ state: 'ready', width: 120, height: 150 });
    });

    describe('warns once when portrait.json is older than the portrait, since its alt and crop may describe the previous photo', () => {
        const stale = /^\[about\] about\/portrait\.json is older than about\/portrait\.jpg, so its alt text and crop may describe the previous photo\. Update it for this one, or remove it\.$/;

        it('after a swap that left portrait.json as it was', async () => {
            put('portrait.json', JSON.stringify({ alt: 'The old photo' }));
            put('portrait.jpg', await jpeg());
            bump('portrait.jpg', 10);
            expect(await read()).toMatchObject({ state: 'ready', alt: 'The old photo' });
            expect(warnings()).toHaveLength(1);
            expect(warnings()[0]).toMatch(stale);
            // Once per photo: the same file again logs nothing more.
            bump('portrait.jpg', 20);
            await read();
            expect(warnings()).toHaveLength(1);
            // The next photo, still with the old portrait.json, logs again.
            put('portrait.jpg', await jpeg(120, 150, { r: 20, g: 90, b: 160 }));
            bump('portrait.jpg', 30);
            await read();
            expect(warnings()).toHaveLength(2);
            expect(warnings()[1]).toMatch(stale);
        });

        it('and not when portrait.json was updated with the photo', async () => {
            put('portrait.jpg', await jpeg());
            put('portrait.json', JSON.stringify({ alt: 'The new photo' }));
            bump('portrait.json', 10);
            expect(await read()).toMatchObject({ state: 'ready', alt: 'The new photo' });
            expect(warnings()).toEqual([]);
        });

        it('and not without a portrait.json', async () => {
            put('portrait.jpg', await jpeg());
            bump('portrait.jpg', 10);
            await read();
            expect(warnings()).toEqual([]);
        });
    });

    describe('gives none, and one warning naming only the relative path and the reason', () => {
        const refused = async (reason: RegExp) => {
            const result = await read();
            expect(result.state).toBe('none');
            if (result.state === 'none') expect(result.reason).toMatch(reason);
            expect(warnings()).toHaveLength(1);
            expect(warnings()[0]).toMatch(/^\[about\] No portrait: .*, so About shows the name instead\.$/);
            expect(warnings()[0]).not.toContain(root);
            expect(warnings()[0]).not.toContain(os.tmpdir());
            // The same state again logs nothing more.
            await read();
            expect(warnings()).toHaveLength(1);
        };

        it('when the site config folder is missing', async () => {
            fs.rmSync(root, { recursive: true });
            await refused(/^the site config folder does not exist$/);
        });

        it('when about/ is missing', async () => {
            await refused(/^about\/ does not exist$/);
        });

        it('when about/ holds no portrait', async () => {
            put('notes.txt', 'hello');
            await refused(/^there is no about\/portrait\.jpg, \.jpeg, \.png, or \.webp$/);
        });

        it('when the name is not lower case', async () => {
            put('Portrait.JPG', await jpeg());
            await refused(/^about\/Portrait\.JPG has to be named in lower case/);
        });

        it('when there are two portraits', async () => {
            put('portrait.jpg', await jpeg());
            put('portrait.png', await png());
            await refused(/^there are 2 portraits, about\/portrait\.jpg and about\/portrait\.png\. Keep one$/);
        });

        it('when the bytes are not an image', async () => {
            put('portrait.jpg', 'not an image at all');
            await refused(/^about\/portrait\.jpg isn't a JPEG, PNG, or WebP file$/);
        });

        it("when the bytes are another format than the name's", async () => {
            put('portrait.jpg', await png());
            await refused(/^about\/portrait\.jpg holds PNG data, but its name says JPEG$/);
        });

        it('when an SVG or HTML file takes the name', async () => {
            put('portrait.png', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
            await refused(/isn't a JPEG, PNG, or WebP file$/);
        });

        it('when the file is cut short', async () => {
            const whole = await jpeg(400, 500);
            put('portrait.jpg', whole.subarray(0, Math.floor(whole.length / 2)));
            await refused(/^about\/portrait\.jpg can't be decoded$/);
        });

        it.each([1, 2, 12])("when a PNG still being copied decodes but is missing its last %i bytes, IEND's", async (cut) => {
            const whole = await png(400, 500);
            put('portrait.png', whole.subarray(0, whole.length - cut));
            await refused(/^about\/portrait\.png doesn't end with a PNG's IEND chunk, so it may still be copying$/);
        });

        it.each([1, 2, 12])('when a WebP is %i bytes shorter than its RIFF header says', async (cut) => {
            const whole = await sharp(await png(400, 500)).webp().toBuffer();
            put('portrait.webp', whole.subarray(0, whole.length - cut));
            await refused(new RegExp(`^about/portrait\\.webp is ${whole.length - cut} bytes, but its RIFF header says ${whole.length}, so it may still be copying$`));
        });

        it('when the file is over the size limit, without reading it', async () => {
            fs.mkdirSync(about(), { recursive: true });
            const handle = fs.openSync(about('portrait.jpg'), 'w');
            fs.writeSync(handle, await jpeg());
            fs.ftruncateSync(handle, PORTRAIT_LIMITS.maxBytes + 1);
            fs.closeSync(handle);
            const readFile = vi.spyOn(fs.promises, 'readFile');
            await refused(/^about\/portrait\.jpg is 40\.0 MB, over the 40\.0 MB limit$/);
            expect(readFile).not.toHaveBeenCalled();
        });

        it('when a side is over the pixel limit, before decoding it', async () => {
            put('portrait.png', pngHeader(PORTRAIT_LIMITS.maxSide + 1, 10));
            await refused(/^about\/portrait\.png is 12001 x 10 px, over the 12000 px limit on a side$/);
        });

        it('when it has more pixels than the limit, before decoding it', async () => {
            put('portrait.png', pngHeader(10_000, 6_000));
            await refused(/^about\/portrait\.png is 60\.0 megapixels, over the 50 megapixel limit$/);
        });

        it('when the portrait is a symlink, even to a good file inside the folder', async () => {
            put('real.jpg', await jpeg());
            fs.symlinkSync(about('real.jpg'), about('portrait.jpg'));
            await refused(/^about\/portrait\.jpg is a symlink, which isn't followed$/);
        });

        it('when the portrait is a symlink to a file outside the folder', async () => {
            const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
            fs.writeFileSync(path.join(outside, 'secret.jpg'), await jpeg());
            fs.mkdirSync(about(), { recursive: true });
            fs.symlinkSync(path.join(outside, 'secret.jpg'), about('portrait.jpg'));
            try {
                await refused(/is a symlink, which isn't followed$/);
            } finally {
                fs.rmSync(outside, { recursive: true, force: true });
            }
        });

        it('when about/ is a symlink', async () => {
            const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-'));
            fs.writeFileSync(path.join(elsewhere, 'portrait.jpg'), await jpeg());
            fs.symlinkSync(elsewhere, about());
            try {
                await refused(/^about\/ is a symlink, which isn't followed$/);
            } finally {
                fs.rmSync(elsewhere, { recursive: true, force: true });
            }
        });

        it('when the portrait is a folder', async () => {
            fs.mkdirSync(about('portrait.jpg'), { recursive: true });
            await refused(/^about\/portrait\.jpg isn't a regular file$/);
        });

        it("when the site config folder is inside the app's public folder", async () => {
            const project = fs.mkdtempSync(path.join(os.tmpdir(), 'project-'));
            const inside = path.join(project, 'public', 'site-config');
            fs.mkdirSync(path.join(inside, 'about'), { recursive: true });
            fs.writeFileSync(path.join(inside, 'about', 'portrait.jpg'), await jpeg());
            vi.spyOn(process, 'cwd').mockReturnValue(project);
            vi.stubEnv(SITE_CONFIG_ENV, inside);
            try {
                await refused(/inside the app's public folder or the photo library/);
            } finally {
                fs.rmSync(project, { recursive: true, force: true });
            }
        });
    });

    describe('keeps the photo and warns once when portrait.json', () => {
        const ignored = async (reason: RegExp) => {
            put('portrait.jpg', await jpeg());
            const result = await read();
            expect(result).toMatchObject({ state: 'ready', alt: null, focalPoint: null });
            expect(warnings()).toHaveLength(1);
            expect(warnings()[0]).toMatch(reason);
            expect(warnings()[0]).toMatch(/so About uses the default alt text and a centered crop\.$/);
            expect(warnings()[0]).not.toContain(root);
            await read();
            expect(warnings()).toHaveLength(1);
        };

        it('is not JSON', async () => {
            put('portrait.json', '{ alt: nope');
            await ignored(/^\[about\] about\/portrait\.json is not valid JSON/);
        });

        it('has a field it does not know', async () => {
            put('portrait.json', JSON.stringify({ alt: 'Fine', focalpoint: { x: 1, y: 2 } }));
            await ignored(/^\[about\] about\/portrait\.json has an unknown field "focalpoint"/);
        });

        it('has a focal point outside 0 to 100', async () => {
            put('portrait.json', JSON.stringify({ focalPoint: { x: 120, y: 2 } }));
            await ignored(/^\[about\] about\/portrait\.json has an invalid focalPoint\.x/);
        });

        it('has an empty alt', async () => {
            put('portrait.json', JSON.stringify({ alt: '   ' }));
            await ignored(/^\[about\] about\/portrait\.json has an invalid alt/);
        });

        it('is over its size limit', async () => {
            put('portrait.json', JSON.stringify({ alt: 'x'.repeat(PORTRAIT_LIMITS.maxJsonBytes) }));
            await ignored(/^\[about\] about\/portrait\.json is .* over the .* limit/);
        });

        it('is a symlink', async () => {
            put('real.json', JSON.stringify({ alt: 'From the link' }));
            fs.symlinkSync(about('real.json'), about('portrait.json'));
            await ignored(/^\[about\] about\/portrait\.json is a symlink, which isn't followed/);
        });
    });

    it('goes back to the photo, logging that, once a refused file is fixed', async () => {
        put('portrait.jpg', 'broken');
        expect((await read()).state).toBe('none');
        put('portrait.jpg', await jpeg());
        bump('portrait.jpg');
        expect((await read()).state).toBe('ready');
        expect(lines()).toEqual([
            "[about] No portrait: about/portrait.jpg isn't a JPEG, PNG, or WebP file, so About shows the name instead.",
            expect.stringMatching(/^\[about\] About shows about\/portrait\.jpg, 120 x 150 px, sha256 [0-9a-f]{12}\.$/),
        ]);
    });

    it('never throws: an unexpected error is a none with its code', async () => {
        put('portrait.jpg', await jpeg());
        vi.spyOn(fs.promises, 'readdir').mockRejectedValueOnce(Object.assign(new Error(`EACCES: permission denied, scandir '${about()}'`), { code: 'EACCES' }));
        const result = await read();
        expect(result).toEqual({ state: 'none', reason: "the portrait can't be read (EACCES)" });
        expect(warnings().join('\n')).not.toContain(root);
    });
});

describe('checkAboutPortrait', () => {
    it('logs what About shows once at start, and the first request after it logs nothing more', async () => {
        await checkAboutPortrait({ logger });
        await read();
        await read();
        expect(lines()).toEqual(["[about] No portrait: about/ does not exist, so About shows the name instead."]);
    });
});
