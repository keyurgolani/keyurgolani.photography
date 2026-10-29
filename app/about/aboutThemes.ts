/**
 * About's Light Takes Shape tokens for Light, Bright and Dark. Black is today's About exactly, the paper in
 * styles/surfaces/light-takes-shape.css, so it sets nothing here.
 *   Light   Light's own paper and mat: toned paper, no ribs, a matted portrait, blue-black link rules.
 *   Bright  the shade lit white: faint grey ribs, a white mat in a 2px black line, the caption on the mat under the
 *           print (P3-3), not a band over the frame's dark ground.
 *   Dark    the lamp at night: warm charcoal, warm ribs, a warm charcoal mat with a warm keyline and glow.
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
const DARK =
  '--lts-paper:#1e1c19;--lts-ink:#f3ecdf;--lts-ink-soft:#d2c9b9;--lts-rib:rgba(255,226,170,.035);' +
  '--lts-rule:rgba(255,236,200,.18);--lts-rule-strong:rgba(255,236,200,.46);--lts-glass:rgba(30,28,25,.92);' +
  '--lts-frame:#2b2824;--lts-shadow:0 0 0 1px rgba(255,230,180,.32),0 20px 70px -14px rgba(255,196,110,.22);' +
  '--lts-link-rule:#a39579;--lts-caption-bg:rgba(30,28,25,.88);--lts-caption-ink:#f3ecdf';

export const ABOUT_THEMES_CSS =
  `html[data-theme=light]{--gah-about-ground:#ebe5d9}html[data-theme=light] [data-surface=about]{${LIGHT}}` +
  `html[data-theme=bright]{--gah-about-ground:#fff}html[data-theme=bright] [data-surface=about]{${BRIGHT}}` +
  `html[data-theme=dark]{--gah-about-ground:#1e1c19}html[data-theme=dark] [data-surface=about]{${DARK}}` +
  // Light Takes Shape's own reduced-transparency rule, which the blocks above would otherwise outrank.
  '@media (prefers-reduced-transparency:reduce){html[data-theme] [data-surface=about]{--lts-glass:var(--lts-paper)}}';
