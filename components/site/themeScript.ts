/**
 * Runs in `<head>` before first paint and before any Next.js script, so the
 * page paints in the visitor's theme from its first frame.
 *
 * The choice is `localStorage.theme`: `system`, `light`, `bright`, `dark` or
 * `black`. Today's stored `light` and `dark` (the old toggle's) keep their
 * meaning, and Dark is today's look. The preview's `charcoal` reads as Dark,
 * with no write. Anything else, nothing stored, or a `localStorage` that throws
 * is System. System resolves to Light or Dark from `prefers-color-scheme`,
 * never Bright or Black.
 *
 * It writes two attributes on `<html>`: `data-theme-choice` (the choice) and
 * `data-theme` (what paints: light, bright, dark or black). Its listeners keep System following the device and
 * apply a choice made in another tab (the `storage` event), before and after
 * React runs.
 *
 * The 503 allows it by its hash (`lib/curation/auth/unavailable.ts`), so any
 * change here changes that hash too. The function keeps its names off
 * `window`, since a classic script's top-level `var` becomes a global.
 */
export const THEME_INIT_SCRIPT =
  "(function(){try{var d=document.documentElement,v=['system','light','bright','dark','black']," +
  "m=window.matchMedia&&matchMedia('(prefers-color-scheme: light)')," +
  "a=function(){var k=d.getAttribute('data-theme-choice');d.setAttribute('data-theme',k==='system'?(m&&m.matches?'light':'dark'):k)}," +
  "r=function(){var c=null;try{c=localStorage.getItem('theme')}catch(e){}if(c==='charcoal')c='dark';if(v.indexOf(c)<0)c='system';d.setAttribute('data-theme-choice',c);a()};" +
  "r();if(m&&m.addEventListener)m.addEventListener('change',a);else if(m&&m.addListener)m.addListener(a);" +
  "window.addEventListener('storage',function(e){if(e.key==='theme'||e.key===null)r()})}catch(e){}})()";
