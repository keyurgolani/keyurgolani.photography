import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canvasSampler, copyTone, TONE_IDLE_FALLBACK_MS, TONE_IDLE_TIMEOUT_MS, TONE_SAMPLE_WIDTH, type Box, type Source } from '../badgePlace';

// The copy tone's sampler (v2.0.0 TBT): decoding the slide on screen into a canvas is a main-thread decode of the
// rung it shows, w1920 on a 3x phone since #6's size rule, about 90 ms of long task at 4x. So it fetches the file the
// slide shows again, which public /media's immutable caching serves from the cache, and decodes it from a Blob, which
// the browser does off the main thread. It never touches the image on screen.

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
    currentSrc: { value: new URL(current, location.href).href, configurable: true },
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
let bitmap: { width: number; height: number; close: ReturnType<typeof vi.fn> };

beforeEach(() => {
  context = { drawImage: vi.fn(), getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(20) })) };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/avif' });
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, blob: async () => blob }));
  bitmap = { width: TONE_SAMPLE_WIDTH, height: 171, close: vi.fn() };
  bitmapMock = vi.fn(async () => bitmap);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('createImageBitmap', bitmapMock);
  // An idle browser, as Chromium is once the slide has loaded. The test without it removes it.
  vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
    queueMicrotask(callback);
    return 1;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** Every argument any decode or draw got, so the image on screen can be looked for in all of them. */
const decodeArguments = () => [...bitmapMock.mock.calls.flat(), ...context.drawImage.mock.calls.flat()];

describe('canvasSampler', () => {
  it('decodes the file the slide shows from a Blob, from the cache, at the sample width, and never the image on screen', async () => {
    const image = slide();
    const pixels = await canvasSampler(image, source);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(new URL(media('w1920', 'avif'), location.href).href);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'only-if-cached', mode: 'same-origin', credentials: 'same-origin' });
    expect(bitmapMock).toHaveBeenCalledTimes(1);
    expect(bitmapMock.mock.calls[0][0]).toBe(blob);
    expect(bitmapMock.mock.calls[0][1]).toMatchObject({ resizeWidth: TONE_SAMPLE_WIDTH, resizeHeight: 171 });
    expect(decodeArguments()).not.toContain(image);
    expect(pixels).not.toBeNull();
  });

  it('decodes at the sample size, not the file\'s, and closes the bitmap once it has drawn it', async () => {
    await canvasSampler(slide(), source);
    expect(bitmapMock.mock.calls[0][1]).toEqual({ resizeWidth: TONE_SAMPLE_WIDTH, resizeHeight: 171, resizeQuality: 'low' });
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(bitmap.close.mock.invocationCallOrder[0]).toBeGreaterThan(context.drawImage.mock.invocationCallOrder[0]);
  });

  it('closes the bitmap when drawing or reading it throws', async () => {
    context.drawImage.mockImplementationOnce(() => {
      throw new DOMException('The image is in an invalid state.', 'InvalidStateError');
    });
    await expect(canvasSampler(slide(), source)).rejects.toThrow();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    document.body.replaceChildren();
    context.getImageData.mockImplementationOnce(() => {
      throw new DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError');
    });
    expect(await copyTone(slide(), copy, { sample: canvasSampler })).toBe('light');
    expect(bitmap.close).toHaveBeenCalledTimes(2);
  });

  it("reads the region in the small copy's pixels, scaled from the image's natural ones", async () => {
    await canvasSampler(slide(), source);
    // 256 / 1920 of the region at (700, 800), 520 x 400.
    expect(context.getImageData).toHaveBeenCalledWith(93, 106, 70, 54);
  });

  it("never downloads the slide again: it reads the file from the cache only, and skips where the browser has no copy", async () => {
    await canvasSampler(slide(), source);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'only-if-cached', mode: 'same-origin' });
    document.body.replaceChildren();
    // WebKit with no HTTP cache to share (private browsing) rejects an only-if-cached fetch, with no request.
    context.getImageData.mockClear();
    fetchMock.mockRejectedValueOnce(new TypeError('Load failed'));
    expect(await copyTone(slide(), copy, { sample: canvasSampler })).toBe('light');
    expect(context.getImageData).not.toHaveBeenCalled();
  });

  it("refetches from the network a file that isn't public /media, as a curator's preview's private, no-store one", async () => {
    // Shipped visitor code can't name the preview's routes (#16's boundary), so the sampler keys on the file: public
    // /media is immutable for a year, from the cache only; any other same-origin file is fetched again.
    await canvasSampler(slide({ current: '/curation/preview/d1/site/media/ph_x/sha256-r/p1/w1920.avif' }), source);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'force-cache', mode: 'same-origin' });
    document.body.replaceChildren();
    fetchMock.mockClear();
    // A public file reads from the cache only, whatever page it's on.
    history.pushState({}, '', '/curation/preview/d1/site');
    try {
      await canvasSampler(slide(), source);
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'only-if-cached', mode: 'same-origin' });
    } finally {
      history.pushState({}, '', '/');
    }
  });

  it("skips, and closes the bitmap, when the browser ignored the resize in either dimension, so it never reads the file's corner", async () => {
    for (const ignored of [{ width: 1920, height: 1280 }, { width: TONE_SAMPLE_WIDTH, height: 1280 }, { width: 1920, height: 171 }]) {
      document.body.replaceChildren();
      const full = { ...ignored, close: vi.fn() };
      bitmapMock.mockResolvedValueOnce(full);
      expect(await copyTone(slide(), copy, { sample: canvasSampler })).toBe('light');
      expect(full.close).toHaveBeenCalledTimes(1);
    }
    expect(context.getImageData).not.toHaveBeenCalled();
  });

  it('fetches nothing for a file the slide shows from another origin, or from a data: URL', async () => {
    for (const current of ['https://cdn.example/media/ph_x/sha256-r/p1/w1920.avif', 'data:image/avif;base64,AAAA']) {
      document.body.replaceChildren();
      expect(await copyTone(slide({ current }), copy, { sample: canvasSampler })).toBe('light');
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bitmapMock).not.toHaveBeenCalled();
  });

  it('asks for an idle moment with a ceiling', async () => {
    const asks: unknown[] = [];
    vi.stubGlobal('requestIdleCallback', vi.fn((callback: () => void, options: unknown) => {
      asks.push(options);
      queueMicrotask(callback);
      return 1;
    }));
    await canvasSampler(slide(), source);
    expect(asks).toEqual([{ timeout: TONE_IDLE_TIMEOUT_MS }]);
  });

  describe('without requestIdleCallback (WebKit), it waits until TONE_IDLE_FALLBACK_MS after the page has loaded', () => {
    const now = vi.fn(() => 0);
    const loadEnd = vi.fn(() => 0);
    beforeEach(() => {
      vi.stubGlobal('requestIdleCallback', undefined);
      vi.spyOn(performance, 'now').mockImplementation(() => now());
      vi.spyOn(performance, 'getEntriesByType').mockImplementation((type: string) => (type === 'navigation' ? [{ loadEventEnd: loadEnd() } as unknown as PerformanceEntry] : []));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => {
      vi.useRealTimers();
      Reflect.deleteProperty(document, 'readyState');
    });

    it('for the rest of that time when the page loaded a moment ago', async () => {
      loadEnd.mockReturnValue(1000);
      now.mockReturnValue(1200);
      const pending = canvasSampler(slide(), source);
      await vi.advanceTimersByTimeAsync(TONE_IDLE_FALLBACK_MS - 200 - 1);
      expect(fetchMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('not at all for a later slide, long after the load, so each slide change keeps its tone', async () => {
      loadEnd.mockReturnValue(1000);
      now.mockReturnValue(60_000);
      const pending = canvasSampler(slide(), source);
      await vi.advanceTimersByTimeAsync(0);
      await pending;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("for the page's load first, while it's still loading", async () => {
      Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });
      now.mockReturnValue(500);
      const pending = canvasSampler(slide(), source);
      await vi.advanceTimersByTimeAsync(10 * TONE_IDLE_FALLBACK_MS);
      expect(fetchMock).not.toHaveBeenCalled();
      now.mockReturnValue(3000);
      window.dispatchEvent(new Event('load'));
      await vi.advanceTimersByTimeAsync(TONE_IDLE_FALLBACK_MS - 1);
      expect(fetchMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
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

    it('without a source the slide shows', async () => {
      const image = slide();
      Object.defineProperty(image, 'currentSrc', { value: '' });
      await expectSkipped(image);
      expect(fetchMock).not.toHaveBeenCalled();
    });

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
