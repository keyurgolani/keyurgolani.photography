/**
 * About's Light Takes Shape tokens for Light, Bright and Black. Dark is today's About exactly, the paper in
 * styles/surfaces/light-takes-shape.css, so it sets nothing here.
 *   Light   Light's own paper and mat: toned paper, no ribs, a matted portrait, blue-black link rules.
 *   Bright  the shade lit white: faint grey ribs, a white mat in a 2px black line, the caption on the mat under the
 *           print (P3-3), not a band over the frame's dark ground.
 *   Black   the screen's own black (OLED, the OLED spec's round 2): no paper, no ribs, no mat or
 *           shadow round the portrait and no frame ground under it, neutral ink, the caption on the black under the print, no
 *           hairline under the nav (the OLED review's C2-5), and no box or resting glow round a link: it lights on
 *           hover and focus (ExternalLinks.module.css reads --about-rule and --about-glow-rest).
 *
 * About's alone, so it rides in About's own HTML as a hoisted stylesheet (AboutPage.tsx), not in the global
 * themes.css: the CSS chunking merges route modules into the chunk every visitor route loads, so a module would put
 * these bytes on every page (the first-load CSS budget). `--gah-about-ground` is the body's ground under the page.
 */
const LIGHT =
  '--lts-paper:#ebe5d9;--lts-glass:#ebe5d9e6;--lts-ink:#29231d;--lts-ink-soft:#4d443a;--lts-ribs:none;' +
  '--lts-rule:#29231d24;--lts-rule-strong:#8c7f6f;--lts-frame:#f8f5ee;' +
  '--lts-shadow:0 0 0 1px #29231d14,0 16px 28px -14px #3c2a146b;--lts-link-rule:#2a4a72;' +
  '--lts-caption-bg:#f8f5eeeb;--lts-caption-ink:#3a3229';
const BRIGHT =
  '--lts-paper:#fff;--lts-ink:#0b0b0b;--lts-ink-soft:#3d3d3d;--lts-rib:#00000009;--lts-rule:#00000029;' +
  '--lts-rule-strong:#767676;--lts-glass:#fff;--lts-frame:#fff;--lts-shadow:0 0 0 2px #111;--lts-link-rule:#767676;' +
  '--lts-caption-bg:#fff;--lts-caption-ink:#0b0b0b';
const BLACK =
  '--lts-paper:#000;--lts-ink:#f5f5f5;--lts-ink-soft:#ffffffc2;--lts-ribs:none;--lts-rule:transparent;' +
  '--lts-rule-strong:#fff6;--lts-glass:#000000f0;--lts-frame:#000;--lts-frame-ground:#000;--lts-shadow:none;' +
  '--lts-link-rule:transparent;--about-glow-rest:0;--lts-caption-bg:transparent;--lts-caption-ink:#f5f5f5';
export const ABOUT_THEMES_CSS =
  // The body's ground under the page is each theme's own ground, which is its paper here.
  'html[data-theme=light],html[data-theme=bright],html[data-theme=black]{--gah-about-ground:var(--gah-ground)}' +
  `[data-theme=light] [data-surface=about]{${LIGHT}}[data-theme=bright] [data-surface=about]{${BRIGHT}}` +
  `[data-theme=black] [data-surface=about]{${BLACK}}` +
  // Light Takes Shape's own reduced-transparency rule, which the blocks above would otherwise outrank.
  '@media (prefers-reduced-transparency:reduce){html[data-theme] [data-surface=about]{--lts-glass:var(--lts-paper)}}';
