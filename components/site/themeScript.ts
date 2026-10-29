/**
 * Runs in `<head>` before first paint and before any Next.js script, so the
 * page paints in the visitor's theme from its first frame.
 *
 * The choice is `localStorage.theme`: `system`, `light`, `bright`, `charcoal`
 * (Dark) or `black`. Today's stored `light` stays Light, and today's stored
 * `dark` reads as Black, today's look (the lead's ruling on owner question 4,
 * 2026-10-28), so the new Dark is stored as `charcoal`. Anything else, nothing
 * stored, or a `localStorage` that throws is System. System resolves to Light or Black from
 * `prefers-color-scheme` (owner ruling, 2026-10-28: a dark device gets Black,
 * today's site), and the listener this script adds keeps it following
 * the device live, before and after React runs.
 *
 * It writes two attributes on `<html>`: `data-theme-choice` (what the visitor
 * chose, as stored) and `data-theme` (what paints: light, bright, dark or
 * black; `charcoal` paints `dark`, so the CSS keys on `dark` as before).
 *
 * MOCKUP ONLY: a `?theme=<choice>` query overrides the stored choice for that
 * page load, without storing it, so the themes mockup can shoot every page in
 * every theme. The real build drops the query branch.
 *
 * The function keeps its names off `window`, since a classic script's
 * top-level `var` becomes a global.
 */
export const THEME_INIT_SCRIPT =
  "(function(){try{var d=document.documentElement,v=['system','light','bright','charcoal','black']," +
  "m=window.matchMedia&&matchMedia('(prefers-color-scheme: light)'),c=null,q=/[?&]theme=([a-z]+)/.exec(location.search);" +
  "if(q&&v.indexOf(q[1])>-1)c=q[1];else try{c=localStorage.getItem('theme')}catch(e){}" +
  "if(c==='dark')c='black';if(v.indexOf(c)<0)c='system';" +
  "var a=function(){var k=d.getAttribute('data-theme-choice');d.setAttribute('data-theme',k==='system'?(m&&m.matches?'light':'black'):k==='charcoal'?'dark':k)};" +
  "d.setAttribute('data-theme-choice',c);a();if(m&&m.addEventListener)m.addEventListener('change',a)}catch(e){}})()";
