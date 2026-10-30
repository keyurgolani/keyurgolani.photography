/**
 * Where Home's badge lands: v1.1.0's place where it clears the chrome, and
 * otherwise the nearest place that does, from the chrome's measured boxes.
 * HeroReveal measures and applies it; this stays pure, so every screen's rule
 * is testable without a browser.
 */

/** A box on screen, as getBoundingClientRect gives it. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Where the badge lands when it isn't v1.1.0's place: px from the viewport's center, and its scale. */
export interface BadgePlace {
  kind: 'clear' | 'side';
  dx: number;
  dy: number;
  scale: number;
}

/** v1.1.0's place: centered, 280 px above the bottom, at 0.85. */
const V110_RISE = 280;
const V110_SCALE = 0.85;
/** The least room the painted oval keeps from the nav, from the series title, statement and link, and from the title's panel. */
const BADGE_CLEARANCE = 16;
/** The ring around the oval. */
const RING = 4;
/** The smallest the badge gets above the story, and its size beside the story on a short landscape screen. */
const MIN_SCALE = 0.6;
/** ProfilePicture.module.css's frame: v1.1.0's 3394 x 3620 shape. */
const FACE_HEIGHT_PER_WIDTH = 3620 / 3394;

/**
 * How far the painted oval, ring included, reaches from the badge's center
 * at `scale`, for the 256 or 320 px card: the frame is the card plus 4 px,
 * its top 2 px above the card's, and it runs at v1.1.0's shape below.
 */
function ovalReach(card: number, scale: number) {
  const width = card + 4;
  const above = card / 2 + 2;
  return { half: (scale * width) / 2 + RING, above: scale * above + RING, below: scale * (width * FACE_HEIGHT_PER_WIDTH - above) + RING };
}

/** ProfilePicture's card from `md` (768 px) up, so on every screen from 85rem. */
const WIDE_CARD = 320;

/**
 * The lane v1.1.0's badge takes on a wide screen: px from the screen's center
 * to the left edge of its painted oval at 0.85 on the 320 px card, plus
 * BADGE_CLEARANCE. From 85rem up, CatalogHome caps the story's copy so the
 * title's panel, fade included, ends this far left of the center
 * (CatalogHome.module.css), and the badge keeps v1.1.0's exact place beside
 * the title. A title that still reaches it, such as one long word, falls back
 * to badgePlace()'s measured lift.
 */
export const V110_LANE = ovalReach(WIDE_CARD, V110_SCALE).half + BADGE_CLEARANCE;

const within = (a: Box, b: Box, gap: number) => a.left < b.right + gap && b.left < a.right + gap && a.top < b.bottom + gap && b.top < a.bottom + gap;

/**
 * The badge's place for a `view`-sized screen, from the measured boxes of the
 * nav and the story's title, statement and link, and the dark panel behind
 * the title and statement from 640 px wide (CatalogHome's `data-chrome-panel`,
 * its fade included). Null keeps v1.1.0's exact place, wherever it clears all
 * of them by BADGE_CLEARANCE. Otherwise the
 * badge stays centered and moves the least from v1.1.0's place that clears
 * them: up above the story (or down, under a nav it reached behind), at 0.85,
 * scaled down toward 0.6 only when the room between the nav and the story is
 * too short for it. With no room even at 0.6, as on a phone held sideways, it
 * goes beside the story instead: a quarter of the width right of the center,
 * 10 px above the middle, at 0.6.
 */
export function badgePlace(view: { width: number; height: number }, card: number, nav: Box | null, story: Box[]): BadgePlace | null {
  if (card <= 0 || view.width <= 0 || view.height <= 0) return null;
  const cx = view.width / 2;
  const home = view.height - V110_RISE;
  const blockers = nav ? [nav, ...story] : story;
  const clears = (cy: number, scale: number) => {
    const reach = ovalReach(card, scale);
    const oval = { left: cx - reach.half, right: cx + reach.half, top: cy - reach.above, bottom: cy + reach.below };
    return blockers.every((box) => !within(oval, box, BADGE_CLEARANCE - 0.01));
  };
  if (clears(home, V110_SCALE)) return null;
  const ceiling = (nav ? nav.bottom : 0) + BADGE_CLEARANCE;
  for (let step = 0; V110_SCALE - step / 100 >= MIN_SCALE - 1e-9; step += 1) {
    const scale = V110_SCALE - step / 100;
    const reach = ovalReach(card, scale);
    // The story in the badge's column, or near it, sets how low it may sit.
    const floor = Math.min(
      view.height - BADGE_CLEARANCE,
      ...story.filter((box) => box.left < cx + reach.half + BADGE_CLEARANCE && cx - reach.half < box.right + BADGE_CLEARANCE).map((box) => box.top - BADGE_CLEARANCE),
    );
    if (floor - ceiling < reach.above + reach.below) continue;
    // As close to v1.1.0's center as the room allows.
    const cy = Math.min(Math.max(home, ceiling + reach.above), floor - reach.below);
    if (clears(cy, scale)) return { kind: 'clear', dx: 0, dy: cy - view.height / 2, scale };
  }
  return { kind: 'side', dx: view.width / 4, dy: -10, scale: MIN_SCALE };
}

/**
 * The top of Home's copy as a percentage of the scrim's height, from the
 * story's measured title, statement and link: where the themed phone wash
 * holds up to (HomeChrome.module.css, --home-copy-top), so a long title or
 * large text keeps the wash under it. Null with no copy, or no scrim, which
 * leaves the stylesheet's 66%.
 */
export function homeCopyTop(stage: Box, story: Box[]): number | null {
  const height = stage.bottom - stage.top;
  if (height <= 0 || story.length === 0) return null;
  const top = Math.min(...story.map((box) => box.top)) - stage.top;
  return Math.round(Math.min(100, Math.max(0, (top / height) * 100)) * 100) / 100;
}

/** Whether Home's chrome scrolls, as large text can make it: then the copy moves under a fixed scrim (M1). */
export function chromeOverflows(scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight > clientHeight + 1;
}

/** The browser's default text size: 1rem at 16px is default text, and more is text the visitor enlarged. */
export const DEFAULT_REM_PX = 16;

/**
 * Whether the visitor enlarged the text, from 1rem in px. Dark's phone wash follows the copy only then (spec §10), so
 * at default text Dark is today's exactly.
 */
export function textEnlarged(remPx: number): boolean {
  return Number.isFinite(remPx) && remPx > DEFAULT_REM_PX;
}

export const boxOf = (element: Element | null): Box | null => {
  if (!element) return null;
  const { left, top, right, bottom } = element.getBoundingClientRect();
  return right > left && bottom > top ? { left, top, right, bottom } : null;
};

/** Which scrim the copy needs over the photograph under it: the theme's own ('light' in Light and Bright) or a dark one. */
export type CopyTone = 'light' | 'dark';

/**
 * The sample's width: the whole photograph is scaled to this, then the copy's region is read from the small copy, so
 * the crop never meets the image's own pixel density (a srcset candidate's intrinsic size isn't its natural size).
 */
export const TONE_SAMPLE_WIDTH = 256;

/**
 * Light only over a clearly light photograph (#125's design delta, P1): a dark scrim over a light-ish photograph
 * reads as dimming, a light one over a mid-tone photograph reads as fog, so the middle goes dark. The contrast rows
 * take each tone's worst pixel, so the split costs no contrast.
 */
export const TONE_LIGHT_FLOOR = 0.36;

const linear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
/** WCAG relative luminance of an sRGB colour. */
export const luminance = (r: number, g: number, b: number) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

/**
 * A region's level from its RGBA pixels, as getImageData gives them: the darker of their mean relative luminance and
 * its 25th percentile, so a dark band under a mostly bright region (the title's first line on a horizon) still counts.
 * Null for no pixels.
 */
export function regionLevel(pixels: ArrayLike<number>): number | null {
  const count = Math.floor(pixels.length / 4);
  if (count === 0) return null;
  const levels = new Float64Array(count);
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    levels[i] = luminance(pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]);
    sum += levels[i];
  }
  levels.sort();
  return Math.min(sum / count, levels[Math.floor((count - 1) * 0.25)]);
}

/** 'dark' below TONE_LIGHT_FLOOR, 'light' from it up. */
export function toneFor(level: number): CopyTone {
  return level < TONE_LIGHT_FLOOR ? 'dark' : 'light';
}

/** A rectangle in an image's natural (density-corrected) pixels, as naturalWidth and naturalHeight count them. */
export interface Source {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The part of an image that paints under `region`, for an image drawn into `shown` with `object-fit: cover` at
 * `position` (fractions, as `object-position`'s percentages), in natural pixels, or null where nothing of it does.
 */
export function coverSource(natural: { width: number; height: number }, shown: Box, region: Box, position = { x: 0.5, y: 0.5 }): Source | null {
  const width = shown.right - shown.left;
  const height = shown.bottom - shown.top;
  if (natural.width <= 0 || natural.height <= 0 || width <= 0 || height <= 0) return null;
  const scale = Math.max(width / natural.width, height / natural.height);
  const offsetX = shown.left + (width - natural.width * scale) * position.x;
  const offsetY = shown.top + (height - natural.height * scale) * position.y;
  const left = Math.max(0, (Math.max(region.left, shown.left) - offsetX) / scale);
  const top = Math.max(0, (Math.max(region.top, shown.top) - offsetY) / scale);
  const right = Math.min(natural.width, (Math.min(region.right, shown.right) - offsetX) / scale);
  const bottom = Math.min(natural.height, (Math.min(region.bottom, shown.bottom) - offsetY) / scale);
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

/** The union of boxes, or null for none. */
export const unionOf = (boxes: Box[]): Box | null =>
  boxes.length === 0
    ? null
    : {
        left: Math.min(...boxes.map((box) => box.left)),
        top: Math.min(...boxes.map((box) => box.top)),
        right: Math.max(...boxes.map((box) => box.right)),
        bottom: Math.max(...boxes.map((box) => box.bottom)),
      };

/** Returns the pixels of `source` (natural pixels) of `image`, or null with no canvas; it throws on a tainted canvas. */
export type ToneSampler = (image: HTMLImageElement, source: Source) => Promise<ArrayLike<number> | null>;

/**
 * The browser's sampler (H1). The whole image is scaled to TONE_SAMPLE_WIDTH, with no crop rectangle, so its pixel
 * density can't enter: createImageBitmap's and drawImage's crop rectangles count the image's intrinsic pixels, and a
 * srcset candidate's intrinsic size isn't its natural size. The region is then read from the small copy, in natural
 * pixels scaled by the same factor. createImageBitmap scales off the main thread where the browser can.
 */
export const canvasSampler: ToneSampler = async (image, source) => {
  const width = TONE_SAMPLE_WIDTH;
  const height = Math.max(1, Math.round((width * image.naturalHeight) / image.naturalWidth));
  const k = width / image.naturalWidth;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(image, { resizeWidth: width, resizeHeight: height, resizeQuality: 'low' });
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
  } else {
    // The five-argument form draws the whole image.
    context.drawImage(image, 0, 0, width, height);
  }
  const x = Math.min(width - 1, Math.floor(source.x * k));
  const y = Math.min(height - 1, Math.floor(source.y * k));
  const w = Math.max(1, Math.min(width - x, Math.ceil(source.width * k)));
  const h = Math.max(1, Math.min(height - y, Math.ceil(source.height * k)));
  return context.getImageData(x, y, w, h).data;
};

/** `object-position` as fractions; anything but two percentages is the centre. */
export const positionOf = (value: string) => {
  const [x, y] = value.split(/\s+/).map((part) => (part.endsWith('%') ? parseFloat(part) / 100 : Number.NaN));
  return { x: Number.isFinite(x) ? x : 0.5, y: Number.isFinite(y) ? y : 0.5 };
};

/**
 * The tone of the photograph under Home's copy: `image` (decoded, as it's drawn now, its box and crop) sampled over
 * `copy`, the union of the story's boxes and the title's panel.
 * - Null when it can't measure now (the image not in, as mid-swap to a larger srcset candidate, or not under the
 *   copy), so the caller keeps what it has and measures again when the image loads (M5).
 * - 'light', the theme's own scrim, when it can't measure at all: no canvas, or a tainted one. Home's media is
 *   same-origin, so it isn't tainted; media moved to another origin would need `crossOrigin` and CORS, or the tone
 *   would stay 'light'.
 */
export async function copyTone(image: HTMLImageElement, copy: Box, { sample = canvasSampler, position = { x: 0.5, y: 0.5 } }: { sample?: ToneSampler; position?: { x: number; y: number } } = {}): Promise<CopyTone | null> {
  if (!image.complete || image.naturalWidth === 0 || image.naturalHeight === 0) return null;
  try {
    await image.decode?.();
  } catch {
    return null;
  }
  const shown = boxOf(image);
  const source = shown && coverSource({ width: image.naturalWidth, height: image.naturalHeight }, shown, copy, position);
  if (!source) return null;
  try {
    const pixels = await sample(image, source);
    const level = pixels ? regionLevel(pixels) : null;
    return level === null ? 'light' : toneFor(level);
  } catch {
    return 'light';
  }
}
