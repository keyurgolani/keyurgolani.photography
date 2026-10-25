/**
 * Runs in `<head>` before first paint and before any Next.js script, so a
 * stored light theme never flashes the dark ground. `localStorage.theme`
 * stays the store, since the browser tests set it with `addInitScript`. Any
 * other stored value is ignored, and a `localStorage` that throws leaves the
 * server's dark default. The function keeps `t` off `window`, since a classic
 * script's top-level `var` becomes a global.
 */
export const THEME_INIT_SCRIPT =
  "(function(){try{var t=localStorage.getItem('theme');" +
  "if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}})()";
