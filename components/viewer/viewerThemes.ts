/**
 * The Viewer in Dark, Light and Bright (spec §3 and §5, round 3's R2-P1-1). Black sets nothing: it is today's
 * Chromatic Chapters (styles/surfaces/chromatic-chapters.css), its bands and translucent bars, and a bare print with
 * today's hairline, from StoryViewer.module.css's fallbacks.
 *   Dark    a charcoal room: the print matted and keylined, as on Work and the series, on a solid #232826 panel.
 *   Light   paper: a toned sheet, the header and reading area on a lighter one, the print in Light's mat with a bevel.
 *   Bright  a white wall: a 14 px white mat in a 3 px black frame.
 * The three share the theme's own ground, ink, label and strong rule (Dark keeps its own ink and label), the caption
 * in the soft ink, and a mat built from #124's primitives (--gah-print-edge, --gah-mat-fill, and md on a phone) in
 * styles/themes.css.
 *
 * The Viewer's alone, so it rides in the Viewer's own HTML as a hoisted stylesheet (StoryViewer.tsx), as About's
 * do (app/about/aboutThemes.ts), not in a module: the CSS chunking puts the Viewer's module on a series' first load,
 * since a series opens the modal Viewer. React inserts it with the modal in one commit, so the first frame has it.
 * ci/themes-budget.mjs counts it on the cold Viewer. Each block outranks the surface's own [data-surface='viewer'].
 */
const THEMED = 'html:is([data-theme=dark],[data-theme=light],[data-theme=bright])';
const SHARED =
  '--cc-ground:var(--gah-ground);--cc-bands:none;--cc-ink:var(--gah-ink);--cc-label:var(--gah-label);' +
  '--cc-caption-ink:var(--cc-ink-soft);--cc-rule-strong:var(--gah-rule-strong);' +
  // The ground the frame keeps clear around its surround, so the mat never meets the screen's edge.
  '--gah-surround-clear:8px;' +
  // The surround replaces today's hairline. Transparent, not none: forced colours drop the surround (box-shadow) and
  // paint an outline in a system colour, so the print keeps an edge there.
  '--gah-viewer-image-outline:1px solid transparent;' +
  // A stale record ratio letterboxes inside the mat instead of stretching the print (P3-6).
  '--gah-viewer-fit:contain;' +
  // The stage clips sideways only, so a print's shadow fades out below it instead of ending on a line.
  '--gah-viewer-clip-y:visible';
const DARK =
  '--cc-ink:#f3f2ec;--cc-ink-soft:#d0d5d1;--cc-label:#aab4af;--cc-chrome:#232826;--cc-rule:rgba(255,255,255,.14);' +
  '--gah-surround-lg:var(--gah-print-edge),0 0 0 14px var(--gah-mat-fill),0 24px 44px -18px rgba(0,0,0,.8);--gah-room-lg:14px';
const LIGHT =
  '--cc-ink-soft:#3a3229;--cc-chrome:#f2ede3;--cc-rule:rgba(41,35,29,.16);' +
  '--gah-surround-lg:var(--gah-print-edge),0 0 0 15px var(--gah-mat-fill),0 0 0 16px rgba(41,35,29,.08),0 22px 40px -18px rgba(60,42,20,.45);--gah-room-lg:16px';
const BRIGHT =
  '--cc-ink-soft:#1a1a1a;--cc-chrome:#fff;--cc-rule:rgba(0,0,0,.1);' +
  '--gah-surround-lg:0 0 0 14px var(--gah-mat-fill),0 0 0 17px #111;--gah-room-lg:17px';

export const VIEWER_THEMES_CSS =
  // The body and the modal's backdrop sit outside the surface, so the ground is on html while a Viewer is open.
  `${THEMED}:has([data-surface=viewer]){--gah-viewer-ground:var(--gah-ground)}` +
  `${THEMED} [data-surface=viewer]{${SHARED}}` +
  `html[data-theme=dark] [data-surface=viewer]{${DARK}}` +
  `html[data-theme=light] [data-surface=viewer]{${LIGHT}}` +
  `html[data-theme=bright] [data-surface=viewer]{${BRIGHT}}`;
