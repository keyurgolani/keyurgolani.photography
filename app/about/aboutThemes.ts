/**
 * About's Light Takes Shape tokens for Light, Bright and Black. Dark is today's About exactly, the paper in
 * styles/surfaces/light-takes-shape.css, so it sets nothing here.
 *   Light   Light's own paper and mat: toned paper, no ribs, a matted portrait, blue-black link rules.
 *   Bright  the shade lit white: faint grey ribs, a white mat in a 2px black line, the caption on the mat under the
 *           print (P3-3), not a band over the frame's dark ground.
 *   Black   the screen's own black: no paper, no ribs, no mat or shadow round the portrait, neutral ink, the caption
 *           on a black band over the print.
 *
 * About's alone, so it rides in About's own HTML as a hoisted stylesheet (AboutPage.tsx), not in the global
 * themes.css: the CSS chunking merges route modules into the chunk every visitor route loads, so a module would put
 * these bytes on every page (the first-load CSS budget). `--gah-about-ground` is the body's ground under the page.
 */
const LIGHT =
  '--lts-paper:#ebe5d9;--lts-glass:rgba(235,229,217,.9);--lts-ink:#29231d;--lts-ink-soft:#4d443a;--lts-ribs:none;' +
  '--lts-rule:rgba(41,35,29,.14);--lts-rule-strong:#8c7f6f;--lts-frame:#f8f5ee;' +
  '--lts-shadow:0 0 0 1px rgba(41,35,29,.08),0 16px 28px -14px rgba(60,42,20,.42);--lts-link-rule:#2a4a72;' +
  '--lts-caption-bg:rgba(248,245,238,.92);--lts-caption-ink:#3a3229';
const BRIGHT =
  '--lts-paper:#fff;--lts-ink:#0b0b0b;--lts-ink-soft:#3d3d3d;--lts-rib:rgba(0,0,0,.035);--lts-rule:rgba(0,0,0,.16);' +
  '--lts-rule-strong:#767676;--lts-glass:#fff;--lts-frame:#fff;--lts-shadow:0 0 0 2px #111;--lts-link-rule:#767676;' +
  '--lts-caption-bg:#fff;--lts-caption-ink:#0b0b0b';
const BLACK =
  '--lts-paper:#000;--lts-ink:#f5f5f5;--lts-ink-soft:rgba(255,255,255,.76);--lts-ribs:none;' +
  '--lts-rule:rgba(255,255,255,.16);--lts-rule-strong:rgba(255,255,255,.4);--lts-glass:rgba(0,0,0,.94);' +
  '--lts-frame:#000;--lts-shadow:none;--lts-link-rule:rgba(255,255,255,.4);--lts-caption-bg:rgba(0,0,0,.78);' +
  '--lts-caption-ink:#f5f5f5';

export const ABOUT_THEMES_CSS =
  `html[data-theme=light]{--gah-about-ground:#ebe5d9}html[data-theme=light] [data-surface=about]{${LIGHT}}` +
  `html[data-theme=bright]{--gah-about-ground:#fff}html[data-theme=bright] [data-surface=about]{${BRIGHT}}` +
  `html[data-theme=black]{--gah-about-ground:#000}html[data-theme=black] [data-surface=about]{${BLACK}}` +
  // Light Takes Shape's own reduced-transparency rule, which the blocks above would otherwise outrank.
  '@media (prefers-reduced-transparency:reduce){html[data-theme] [data-surface=about]{--lts-glass:var(--lts-paper)}}';
