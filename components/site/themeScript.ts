/**
 * Runs in `<head>` before first paint and before any Next.js script, so the
 * page paints in the visitor's theme from its first frame.
 *
 * The choice is `localStorage.theme`: `system`, `light`, `bright`, `charcoal`
 * (Dark) or `black`. Today's stored `light` stays Light, and today's stored
 * `dark` (the old toggle's) reads as Dark, today's look, with no write.
 * Anything else, nothing stored, or a `localStorage` that throws is System.
 * System resolves to Light or Dark from `prefers-color-scheme`, never Bright
 * or Black (the owner, 2026-10-29).
 *
 * It writes two attributes on `<html>`: `data-theme-choice` (the choice, as
 * stored) and `data-theme` (what paints: light, bright, dark or black;
 * `charcoal` paints `dark`). Its listeners keep System following the device and
 * apply a choice made in another tab (the `storage` event), before and after
 * React runs.
 *
 * The 503 allows it by its hash (`lib/curation/auth/unavailable.ts`), so any
 * change here changes that hash too. The function keeps its names off
 * `window`, since a classic script's top-level `var` becomes a global.
 */
export const THEME_INIT_SCRIPT =
  "(function(){try{var d=document.documentElement,v=['system','light','bright','charcoal','black']," +
  "m=window.matchMedia&&matchMedia('(prefers-color-scheme: light)')," +
  "a=function(){var k=d.getAttribute('data-theme-choice');d.setAttribute('data-theme',k==='system'?(m&&m.matches?'light':'dark'):k==='charcoal'?'dark':k)}," +
  "r=function(){var c=null;try{c=localStorage.getItem('theme')}catch(e){}if(c==='dark')c='charcoal';if(v.indexOf(c)<0)c='system';d.setAttribute('data-theme-choice',c);a()};" +
  "r();if(m&&m.addEventListener)m.addEventListener('change',a);else if(m&&m.addListener)m.addListener(a);" +
  "window.addEventListener('storage',function(e){if(e.key==='theme'||e.key===null)r()})}catch(e){}})()";
