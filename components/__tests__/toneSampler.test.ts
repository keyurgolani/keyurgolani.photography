import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canvasSampler, copyTone, TONE_SAMPLE_WIDTH, toneSampleUrl, type Box, type Source } from '../badgePlace';

// The copy tone's sampler (v2.0.0 TBT): decoding the slide on screen into a canvas is a main-thread decode of the
// rung it shows, w1920 on a 3x phone since #6's size rule, about 90 ms of long task at 4x. The sample is only
// TONE_SAMPLE_WIDTH wide, so it reads the smallest rung at least that wide, fetched and decoded from a Blob, which the
// browser decodes off the main thread, and never touches the image on screen.

const media = (variant: string, format: string) => `/media/ph_x/sha256-r/p1/${variant}.${format}`;
const srcset = (format: string, widths = [400, 800, 1200, 1920]) => widths.map((width) => `${media(`w${width}`, format)} ${width}w`).join(', ');

/** A slide as ResponsivePhoto renders it: AVIF and WebP sources, and an img showing `current`. */
function slide({ current = media('w1920', 'avif'), avif = srcset('avif'), webp = srcset('webp') } = {}) {
  const picture = document.createElement('picture');
  for (const [type, set] of [['image/avif', avif], ['image/webp', webp]]) {
    const source = document.createElement('source');
    source.type = type;
    source.setAttribute('srcset', set);
    source.setAttribute('sizes', '(min-aspect-ratio: 1500/1000) 100vw, 150vh');
    picture.append(source);
  }
  const image = document.createElement('img');
  image.src = media('w1200', 'webp');
  picture.append(image);
  document.body.append(picture);
  Object.defineProperties(image, {
    currentSrc: { value: new URL(current, location.href).href },
    complete: { value: true },
    naturalWidth: { value: 1920 },
    naturalHeight: { value: 1280 },
    decode: { value: () => Promise.resolve() },
    getBoundingClientRect: { value: () => ({ left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844 }) },
  });
  return image;
}

const source: Source = { x: 700, y: 800, width: 520, height: 400 };
const copy: Box = { left: 24, top: 560, right: 366, bottom: 800 };

let context: { drawImage: ReturnType<typeof vi.fn>; getImageData: ReturnType<typeof vi.fn> };
let blob: Blob;
let fetchMock: ReturnType<typeof vi.fn>;
let bitmapMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  context = { drawImage: vi.fn(), getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(20) })) };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/avif' });
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, blob: async () => blob }));
  bitmapMock = vi.fn(async () => ({ width: TONE_SAMPLE_WIDTH, height: 171, close: vi.fn() }));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('createImageBitmap', bitmapMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** Every argument any decode or draw got, so the image on screen can be looked for in all of them. */
const decodeArguments = () => [...bitmapMock.mock.calls.flat(), ...context.drawImage.mock.calls.flat()];

describe('toneSampleUrl', () => {
  it("is the smallest rung at least TONE_SAMPLE_WIDTH wide in the srcset the slide shows from, in that source's format", () => {
    expect(toneSampleUrl(slide())).toBe(new URL(media('w400', 'avif'), location.href).href);
    document.body.replaceChildren();
    expect(toneSampleUrl(slide({ current: media('w1200', 'webp') }))).toBe(new URL(media('w400', 'webp'), location.href).href);
  });

  it('passes over a rung narrower than the sample, and takes the widest when none is as wide', () => {
    expect(toneSampleUrl(slide({ current: media('w1200', 'avif'), avif: srcset('avif', [200, 640, 1200]) }))).toBe(new URL(media('w640', 'avif'), location.href).href);
    document.body.replaceChildren();
    expect(toneSampleUrl(slide({ current: media('w240', 'avif'), avif: srcset('avif', [120, 240]) }))).toBe(new URL(media('w240', 'avif'), location.href).href);
  });

  it('is nothing when the image shows from no srcset it can read', () => {
    expect(toneSampleUrl(slide({ current: '/elsewhere.avif' }))).toBeNull();
  });
});

describe('canvasSampler', () => {
  it('decodes the small rung from a Blob, at the sample width, and never the image on screen', async () => {
    const image = slide();
    const pixels = await canvasSampler(image, source);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(new URL(media('w400', 'avif'), location.href).href);
    expect(bitmapMock).toHaveBeenCalledTimes(1);
    expect(bitmapMock.mock.calls[0][0]).toBe(blob);
    expect(bitmapMock.mock.calls[0][1]).toMatchObject({ resizeWidth: TONE_SAMPLE_WIDTH, resizeHeight: 171 });
    expect(decodeArguments()).not.toContain(image);
    expect(pixels).not.toBeNull();
  });

  it("reads the region in the small copy's pixels, scaled from the image's natural ones", async () => {
    await canvasSampler(slide(), source);
    // 256 / 1920 of the region at (700, 800), 520 x 400.
    expect(context.getImageData).toHaveBeenCalledWith(93, 106, 70, 54);
  });

  it("waits for the browser to be idle before it fetches, so it doesn't compete with the slide's own load", async () => {
    const idle: Array<() => void> = [];
    vi.stubGlobal('requestIdleCallback', vi.fn((callback: () => void) => idle.push(callback)));
    const pending = canvasSampler(slide(), source);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(idle).toHaveLength(1);
    idle[0]();
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe("skips quietly, so the theme keeps its own scrim, and never decodes the image on screen when it can't sample", () => {
    const expectSkipped = async (image: HTMLImageElement) => {
      const errors = vi.spyOn(console, 'error');
      expect(await copyTone(image, copy, { sample: canvasSampler })).toBe('light');
      expect(decodeArguments()).not.toContain(image);
      expect(context.getImageData).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    };

    it('without createImageBitmap', async () => {
      vi.stubGlobal('createImageBitmap', undefined);
      await expectSkipped(slide());
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('when the fetch fails, or answers with an error', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await expectSkipped(slide());
      document.body.replaceChildren();
      fetchMock.mockResolvedValueOnce({ ok: false, status: 404, blob: async () => blob });
      await expectSkipped(slide());
      expect(bitmapMock).not.toHaveBeenCalled();
    });

    it('when the decode rejects', async () => {
      bitmapMock.mockRejectedValueOnce(new DOMException('The source image could not be decoded.', 'InvalidStateError'));
      await expectSkipped(slide());
      expect(bitmapMock).toHaveBeenCalledTimes(1);
    });
  });
});
