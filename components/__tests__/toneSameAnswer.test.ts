import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOME_FIXTURE_CATALOG, VARIETY_FIXTURE_CATALOG } from '@/e2e/support/homeFixture';
import { buildTestAssetFiles } from '@/lib/catalog/testing';
import { canvasSampler, copyTone, regionLevel, type Box } from '../badgePlace';

// The tone from the small rung is the tone from the image on screen (v2.0.0 TBT). Each fixture's own derivative files,
// as /media serves them, go through copyTone() and canvasSampler(): once from the slide's whole srcset, which samples
// its smallest rung at least TONE_SAMPLE_WIDTH wide, and once from a srcset of only the rung the slide shows, w1920 on
// both profiles under #6's size rule, and v1.7.0's phone rung, w1200. The browser's createImageBitmap and 2D canvas are
// stood in for by sharp, the same resize for every rung. Badge placement (badgePlace()) reads only the chrome's boxes,
// never the photograph, so no rung can move it.

type Bitmap = { width: number; height: number; data: Uint8ClampedArray; close: () => void };
type Photo = { url: (variant: 'w400' | 'w800' | 'w1200' | 'w1920') => string; width: number; height: number };

const PROFILES = {
  phone: { view: { width: 390, height: 844 }, copy: { left: 24, top: 560, right: 366, bottom: 800 } },
  desktop: { view: { width: 1440, height: 900 }, copy: { left: 80, top: 560, right: 760, bottom: 840 } },
} satisfies Record<string, { view: { width: number; height: number }; copy: Box }>;

let files: Map<string, Buffer>;
const blobs = new WeakMap<Blob, Buffer>();

beforeEach(() => {
  files = new Map();
  vi.stubGlobal('fetch', async (url: string) => {
    const bytes = files.get(new URL(url).pathname);
    if (!bytes) return { ok: false, status: 404, blob: async () => new Blob([]) };
    const blob = new Blob([new Uint8Array(bytes)]);
    blobs.set(blob, bytes);
    return { ok: true, status: 200, blob: async () => blob };
  });
  vi.stubGlobal('createImageBitmap', async (blob: Blob, { resizeWidth, resizeHeight }: { resizeWidth: number; resizeHeight: number }): Promise<Bitmap> => {
    const bytes = blobs.get(blob);
    if (!bytes) throw new Error('Not a Blob the fetch gave.');
    const { data, info } = await sharp(bytes).resize(resizeWidth, resizeHeight, { fit: 'fill', kernel: 'linear' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data: new Uint8ClampedArray(data), close: () => undefined };
  });
  let drawn: Bitmap | null = null;
  const context = {
    drawImage: (bitmap: Bitmap) => {
      drawn = bitmap;
    },
    getImageData: (x: number, y: number, w: number, h: number) => {
      if (!drawn) throw new Error('Nothing drawn.');
      const out = new Uint8ClampedArray(w * h * 4);
      for (let row = 0; row < h; row++) out.set(drawn.data.subarray(((y + row) * drawn.width + x) * 4, ((y + row) * drawn.width + x + w) * 4), row * w * 4);
      return { data: out };
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** The slide, covering `view`, showing w1920 from a srcset of `variants`. */
function slide(photo: Photo, variants: ReadonlyArray<'w400' | 'w800' | 'w1200' | 'w1920'>, view: { width: number; height: number }) {
  const picture = document.createElement('picture');
  const source = document.createElement('source');
  source.type = 'image/avif';
  const widths = new Map(variants.map((variant) => [variant, Math.min(Number(variant.slice(1)), photo.width)]));
  source.setAttribute('srcset', variants.map((variant) => `${photo.url(variant)} ${widths.get(variant)}w`).join(', '));
  const image = document.createElement('img');
  picture.append(source, image);
  document.body.append(picture);
  const shown = variants.at(-1)!;
  const naturalWidth = widths.get(shown)!;
  Object.defineProperties(image, {
    currentSrc: { value: new URL(photo.url(shown), location.href).href },
    complete: { value: true },
    naturalWidth: { value: naturalWidth },
    naturalHeight: { value: Math.round((naturalWidth * photo.height) / photo.width) },
    decode: { value: () => Promise.resolve() },
    getBoundingClientRect: { value: () => ({ left: 0, top: 0, right: view.width, bottom: view.height, width: view.width, height: view.height }) },
  });
  return image;
}

/** The tone, and the level it came from, through copyTone() and canvasSampler(). */
async function toneOf(photo: Photo, variants: ReadonlyArray<'w400' | 'w800' | 'w1200' | 'w1920'>, profile: keyof typeof PROFILES) {
  const { view, copy } = PROFILES[profile];
  let level: number | null = null;
  const tone = await copyTone(slide(photo, variants, view), copy, {
    sample: async (image, region) => {
      const pixels = await canvasSampler(image, region);
      level = pixels ? regionLevel(pixels) : null;
      return pixels;
    },
  });
  document.body.replaceChildren();
  return { tone, level };
}

/** Each rung's answer against the small rung's, for one photograph on both profiles. */
async function expectSameAnswer(name: string, photo: Photo) {
  for (const profile of Object.keys(PROFILES) as Array<keyof typeof PROFILES>) {
    const small = await toneOf(photo, ['w400', 'w800', 'w1200', 'w1920'], profile);
    expect(small.level, `${name} on the ${profile}: the small rung was sampled`).not.toBeNull();
    for (const shown of [['w1920'], ['w1200']] as const) {
      const full = await toneOf(photo, shown, profile);
      expect(small.tone, `${name} on the ${profile}: w400 level ${small.level} against ${shown[0]} level ${full.level}`).toBe(full.tone);
    }
  }
}

const fixturePhotos = async (catalog: typeof HOME_FIXTURE_CATALOG | typeof VARIETY_FIXTURE_CATALOG) => {
  const built = await buildTestAssetFiles(catalog);
  for (const [url, bytes] of built.files) files.set(url, bytes);
  return built.photos.map((record) => ({ id: record.id, photo: { url: (variant) => record.variants[variant].avif.url, width: record.width, height: record.height } satisfies Photo }));
};

describe('the copy tone from the small rung', () => {
  it.each([
    ['one', HOME_FIXTURE_CATALOG],
    ['variety', VARIETY_FIXTURE_CATALOG],
  ] as const)("is the tone from the image on screen for every photograph in the %s fixture, on the phone and the desktop", async (_name, catalog) => {
    const photos = await fixturePhotos(catalog);
    expect(photos.length).toBeGreaterThan(0);
    for (const { id, photo } of photos) await expectSameAnswer(id, photo);
  }, 60_000);

  // The fixtures are solid colours, which any rung samples alike, so two that aren't: the halves e2e/home-catalog.spec.ts's
  // H1 cases serve, and a dark-to-light ramp whose level under the copy sits near TONE_LIGHT_FLOOR on the phone.
  it.each([
    ['a light top over a dark bottom', (y: number) => (y < 640 ? [0xf4, 0xf1, 0xea] : [0x0a, 0x10, 0x18])],
    ['a dark top over a light bottom', (y: number) => (y < 640 ? [0x0a, 0x10, 0x18] : [0xf4, 0xf1, 0xea])],
    ['a ramp from black to white', (y: number) => Array(3).fill(Math.round((y / 1279) * 255))],
  ] as const)('is the tone from the image on screen over %s', async (name, colour) => {
    const pixels = Buffer.alloc(1920 * 1280 * 3);
    for (let y = 0; y < 1280; y++) {
      const rgb = colour(y);
      for (let x = 0; x < 1920; x++) pixels.set(rgb, (y * 1920 + x) * 3);
    }
    const source = sharp(pixels, { raw: { width: 1920, height: 1280, channels: 3 } });
    const url = (variant: string) => `/media/ph_made/sha256-made/p1/${variant}.avif`;
    for (const width of [400, 800, 1200, 1920]) files.set(url(`w${width}`), await source.clone().resize(width).avif({ quality: 50, effort: 0 }).toBuffer());
    await expectSameAnswer(name, { url, width: 1920, height: 1280 });
  }, 60_000);
});
