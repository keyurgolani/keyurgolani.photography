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
 * The top of Home's copy as a percentage of the stage's height, from the
 * story's measured title, statement and link: where Light's and Bright's
 * phone wash holds up to (HomeChrome.module.css, --home-copy-top), so a long
 * title or large text keeps the wash under it. Null with no copy, or no
 * stage, which leaves the stylesheet's 66%.
 */
export function homeCopyTop(stage: Box, story: Box[]): number | null {
  const height = stage.bottom - stage.top;
  if (height <= 0 || story.length === 0) return null;
  const top = Math.min(...story.map((box) => box.top)) - stage.top;
  return Math.round(Math.min(100, Math.max(0, (top / height) * 100)) * 100) / 100;
}

/** The browser's default text size: 1rem at 16px is default text, and more is text the visitor enlarged. */
export const DEFAULT_REM_PX = 16;

/**
 * Whether the visitor enlarged the text, from 1rem in px. Black's phone wash follows the copy only then (spec §10), so
 * at default text Black is today's exactly.
 */
export function textEnlarged(remPx: number): boolean {
  return Number.isFinite(remPx) && remPx > DEFAULT_REM_PX;
}

export const boxOf = (element: Element | null): Box | null => {
  if (!element) return null;
  const { left, top, right, bottom } = element.getBoundingClientRect();
  return right > left && bottom > top ? { left, top, right, bottom } : null;
};
