import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOME_FIXTURE_CATALOG, VARIETY_FIXTURE_CATALOG } from '@/test/helpers/homeFixtureCatalogs';
import { buildTestAssetFiles } from '@/lib/catalog/testing';
import { canvasSampler, copyTone, coverSource, regionLevel, toneFor, TONE_SAMPLE_WIDTH, type Box, type CopyTone, type Source } from '../badgePlace';

// The tone from the fetched file is the tone from the image on screen (v2.0.0 TBT). Each fixture's own derivative
// files, as /media serves them, go through copyTone() and canvasSampler(), which fetch the file the slide shows and
// decode the Blob. The answer to match is the pre-#193 sampler's, which scaled the image on screen itself: the same
// file, decoded straight from its bytes, with no fetch and no Blob, scaled to TONE_SAMPLE_WIDTH and read over the same
// region. sharp stands in for the browser's decode and scale on both sides. Badge placement (badgePlace()) reads only
// the chrome's boxes, never the photograph, so no change to the sampler can move it.

type Bitmap = { width: number; height: number; data: Uint8ClampedArray; close: () => void };
type Resize = { resizeWidth: number; resizeHeight: number };
type Crop = { left: number; top: number; width: number; height: number };
/**
 * A file at `url`, `width` by `height`, and the natural size the browser reports for it, which is the file's own unless
 * `natural` says otherwise: a srcset candidate's is density-corrected, as 389 by 259 for a 1920 by 1280 file.
 */
type Photo = { url: string; width: number; height: number; natural?: { width: number; height: number } };

const naturalOf = (photo: Photo) => photo.natural ?? { width: photo.width, height: photo.height };

const PROFILES = {
  phone: { view: { width: 390, height: 844 }, copy: { left: 24, top: 560, right: 366, bottom: 800 } },
  desktop: { view: { width: 1440, height: 900 }, copy: { left: 80, top: 560, right: 760, bottom: 840 } },
} satisfies Record<string, { view: { width: number; height: number }; copy: Box }>;

let files: Map<string, Buffer>;
let fetched: string[];
const blobs = new WeakMap<Blob, Buffer>();

/** `bytes` decoded, cut to `crop` (file pixels) when there is one, and scaled to `width` by `height` as RGBA. */
async function scaled(bytes: Buffer, width: number, height: number, crop?: Crop) {
  const decoded = crop ? sharp(bytes).extract(crop) : sharp(bytes);
  const { data, info } = await decoded.resize(width, height, { fit: 'fill', kernel: 'linear' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
}

/** Rows `y` to `y + h` and columns `x` to `x + w` of an RGBA bitmap. */
function region(bitmap: { width: number; data: Uint8ClampedArray }, x: number, y: number, w: number, h: number) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) out.set(bitmap.data.subarray(((y + row) * bitmap.width + x) * 4, ((y + row) * bitmap.width + x + w) * 4), row * w * 4);
  return out;
}

beforeEach(() => {
  // An idle browser, as Chromium is once the slide has loaded, so no sample waits on WebKit's fallback.
  vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
    queueMicrotask(callback);
    return 1;
  });
  files = new Map();
  fetched = [];
  vi.stubGlobal('fetch', async (url: string) => {
    fetched.push(new URL(url).pathname);
    const bytes = files.get(new URL(url).pathname);
    if (!bytes) return { ok: false, status: 404, blob: async () => new Blob([]) };
    const blob = new Blob([new Uint8Array(bytes)]);
    blobs.set(blob, bytes);
    return { ok: true, status: 200, blob: async () => blob };
  });
  // Both of the browser's forms: the whole file, or a rectangle of it in the file's own pixels, then the resize.
  vi.stubGlobal('createImageBitmap', async (blob: Blob, ...rest: [Resize] | [number, number, number, number, Resize]): Promise<Bitmap> => {
    const bytes = blobs.get(blob);
    if (!bytes) throw new Error('Not a Blob the fetch gave.');
    const { resizeWidth, resizeHeight } = rest.length === 1 ? rest[0] : rest[4];
    const crop = rest.length === 1 ? undefined : { left: rest[0], top: rest[1], width: rest[2], height: rest[3] };
    return { ...(await scaled(bytes, resizeWidth, resizeHeight, crop)), close: () => undefined };
  });
  let drawn: Bitmap | null = null;
  const context = {
    drawImage: (bitmap: Bitmap) => {
      drawn = bitmap;
    },
    getImageData: (x: number, y: number, w: number, h: number) => {
      if (!drawn) throw new Error('Nothing drawn.');
      return { data: region(drawn, x, y, w, h) };
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** The slide, covering `view`, showing `photo`'s file. */
function slide(photo: Photo, view: { width: number; height: number }) {
  const image = document.createElement('img');
  document.body.append(image);
  Object.defineProperties(image, {
    currentSrc: { value: new URL(photo.url, location.href).href },
    complete: { value: true },
    naturalWidth: { value: naturalOf(photo).width },
    naturalHeight: { value: naturalOf(photo).height },
    decode: { value: () => Promise.resolve() },
    getBoundingClientRect: { value: () => ({ left: 0, top: 0, right: view.width, bottom: view.height, width: view.width, height: view.height }) },
  });
  return image;
}

/**
 * The pre-#193 sampler's pixels: the image on screen, at the natural size the browser reports, scaled whole to
 * TONE_SAMPLE_WIDTH, read over `source`.
 */
async function onScreenPixels(photo: Photo, source: Source) {
  const natural = naturalOf(photo);
  const width = TONE_SAMPLE_WIDTH;
  const height = Math.max(1, Math.round((width * natural.height) / natural.width));
  const k = width / natural.width;
  const bitmap = await scaled(files.get(photo.url)!, width, height);
  const x = Math.min(width - 1, Math.floor(source.x * k));
  const y = Math.min(height - 1, Math.floor(source.y * k));
  return region(bitmap, x, y, Math.max(1, Math.min(width - x, Math.ceil(source.width * k))), Math.max(1, Math.min(height - y, Math.ceil(source.height * k))));
}

/** The fetched file's tone and pixels against the on-screen image's, on both profiles. Returns the tone on each. */
async function expectSameAnswer(name: string, photo: Photo) {
  const tones: Record<string, CopyTone | null> = {};
  for (const [profile, { view, copy }] of Object.entries(PROFILES)) {
    let pixels: ArrayLike<number> | null = null;
    const tone = await copyTone(slide(photo, view), copy, {
      sample: async (image, source) => (pixels = await canvasSampler(image, source)),
    });
    document.body.replaceChildren();
    const source = coverSource(naturalOf(photo), { left: 0, top: 0, right: view.width, bottom: view.height }, copy)!;
    const expected = await onScreenPixels(photo, source);
    const level = regionLevel(expected)!;
    expect(fetched.at(-1), `${name} on the ${profile}: the sampler fetched the file on screen`).toBe(photo.url);
    expect(pixels, `${name} on the ${profile}: the fetched file's pixels are the image's`).toEqual(expected);
    expect(tone, `${name} on the ${profile}: the image's level is ${level}`).toBe(toneFor(level));
    tones[profile] = tone;
  }
  return tones;
}

const fixturePhotos = async (catalog: typeof HOME_FIXTURE_CATALOG | typeof VARIETY_FIXTURE_CATALOG) => {
  const built = await buildTestAssetFiles(catalog);
  for (const [url, bytes] of built.files) files.set(url, bytes);
  // Home's slide shows w1920 on both profiles under #6's size rule, and w1200 was v1.7.0's phone rung.
  return built.photos.flatMap((record) => (['w1920', 'w1200'] as const).map((variant) => ({ name: `${record.id} ${variant}`, photo: { url: record.variants[variant].avif.url, width: record.variants[variant].avif.width, height: record.variants[variant].avif.height } })));
};

// The fixtures are solid colours, so three that aren't: the halves e2e/home-catalog.spec.ts's H1 cases serve, and a
// black-to-white ramp, each 1920 by 1280.
const MADE = [
  ['a light top over a dark bottom', (y: number) => (y < 640 ? [0xf4, 0xf1, 0xea] : [0x0a, 0x10, 0x18])],
  ['a dark top over a light bottom', (y: number) => (y < 640 ? [0x0a, 0x10, 0x18] : [0xf4, 0xf1, 0xea])],
  ['a ramp from black to white', (y: number) => Array(3).fill(Math.round((y / 1279) * 255))],
] as const;

/** A made photograph, `colour` by row, served as /media serves a w1920 AVIF. */
async function made(colour: (y: number) => readonly number[]): Promise<Photo> {
  const pixels = Buffer.alloc(1920 * 1280 * 3);
  for (let y = 0; y < 1280; y++) {
    const rgb = colour(y);
    for (let x = 0; x < 1920; x++) pixels.set(rgb, (y * 1920 + x) * 3);
  }
  const url = '/media/ph_made/sha256-made/p1/w1920.avif';
  files.set(url, await sharp(pixels, { raw: { width: 1920, height: 1280, channels: 3 } }).avif({ quality: 50, effort: 0 }).toBuffer());
  return { url, width: 1920, height: 1280 };
}

describe('the copy tone from the fetched file', () => {
  it.each([
    ['one', HOME_FIXTURE_CATALOG],
    ['variety', VARIETY_FIXTURE_CATALOG],
  ] as const)('is the tone from the image on screen for every photograph in the %s fixture, on the phone and the desktop', async (_name, catalog) => {
    const photos = await fixturePhotos(catalog);
    expect(photos.length).toBeGreaterThan(0);
    for (const { name, photo } of photos) await expectSameAnswer(name, photo);
  }, 60_000);

  it.each(MADE)('is the tone from the image on screen over %s', async (name, colour) => {
    await expectSameAnswer(name, await made(colour));
  }, 60_000);

  // The probe's numbers: a 1920 by 1280 file the browser took from a srcset reports 389 by 259 (#209). The whole file
  // is scaled to the sample size and the region read in natural pixels by the same factor, so the density can't enter.
  it('is the tone from the image on screen, and the same tone as at the file\'s own size, when the browser reports a density-corrected natural size', async () => {
    for (const [name, colour] of MADE) {
      const photo = await made(colour);
      const atFileSize = await expectSameAnswer(name, photo);
      const corrected = await expectSameAnswer(`${name} at 389 by 259`, { ...photo, natural: { width: 389, height: 259 } });
      expect(corrected, `${name}: the density-corrected size gives the file's own tone`).toEqual(atFileSize);
    }
  }, 60_000);
});
