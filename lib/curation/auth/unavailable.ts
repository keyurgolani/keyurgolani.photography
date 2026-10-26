import { createHash } from 'node:crypto';
import { CURATOR_RESPONSE_HEADERS } from './policy';

/**
 * What the curator answers on every path while its setup is incomplete (the
 * 503 `misconfigured` refusal, in practice a secret file missing,
 * unreadable, loose or malformed): one fixed HTML page, so the owner who just deployed learns
 * what's wrong and where to look instead of reading a bare status line.
 *
 * It's a constant. Nothing from the request goes into it, and it doesn't say
 * which file or setting failed; the startup log does (instrumentation.ts).
 * It loads nothing: no script, no font, no image, and its one stylesheet is
 * inline, allowed by its hash in a Content-Security-Policy that allows
 * nothing else. The colors and sizes are Gallery After Hours' tokens
 * (styles/tokens.css), and the type falls back to the system faces, since
 * the site's own fonts are files it would have to load. The block is
 * centred a little above the middle, as the login's is.
 */

const STYLE = [
    ':root{color-scheme:dark}',
    '*{box-sizing:border-box}',
    'html,body{margin:0}',
    'body{display:flex;min-height:100svh;flex-direction:column;background:#080a09;color:#f4f6f5;font:0.875rem/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased}',
    'header{display:flex;min-height:3.5rem;align-items:center;gap:0.625rem;padding:0.375rem clamp(1rem,3.3vw,3rem);border-bottom:1px solid #343936;background:#171a18;font-size:0.75rem;font-weight:500;letter-spacing:0.045em}',
    '.mark{display:inline-grid;width:2rem;height:2rem;place-items:center;border:1px solid rgba(255,255,255,0.38);border-radius:50%;font-family:Georgia,"Times New Roman",serif}',
    'main{display:flex;flex:1;align-items:center;justify-content:center;padding:3rem clamp(1rem,3.3vw,3rem) max(4rem,12svh)}',
    '.body{width:100%;max-width:34rem}',
    'h1{margin:0;font-family:Georgia,"Times New Roman",serif;font-size:clamp(2rem,1.6rem + 1.6vw,2.75rem);font-weight:400;line-height:1.05;letter-spacing:-0.02em;text-wrap:balance}',
    'p{margin:1.25rem 0 0;color:rgba(244,246,245,0.76);font-size:clamp(1rem,0.9rem + 0.4vw,1.1875rem);line-height:1.5;text-wrap:pretty}',
    'code{color:#f4f6f5;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.9em}',
].join('');

/** The page itself. */
export const UNAVAILABLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="dark">
<title>Curator unavailable · Keyur Golani Photography</title>
<style>${STYLE}</style>
</head>
<body>
<header><span class="mark" aria-hidden="true">KG</span>Portfolio curation</header>
<main>
<div class="body">
<h1>The curator can't sign you in yet</h1>
<p>A secret file it needs is missing, unreadable, readable by anyone but its owner, or not in the format the setup commands write, so every page it serves answers with this one.</p>
<p>The curator's log names the setting that's wrong. Make the files as <code>docs/curator.md</code> shows under "Making them", then restart curator on the server.</p>
</div>
</main>
</body>
</html>
`;

const STYLE_HASH = `'sha256-${createHash('sha256').update(STYLE).digest('base64')}'`;

/** Allows the one inline stylesheet and nothing else, and no framing, like every curator response. */
export const UNAVAILABLE_CSP = `default-src 'none'; style-src ${STYLE_HASH}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

/** The page's headers: every curator response header, and its own type and policy. */
export const UNAVAILABLE_HEADERS: Readonly<Record<string, string>> = {
    ...CURATOR_RESPONSE_HEADERS,
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': UNAVAILABLE_CSP,
};

/** The 503, for a route handler. proxy.ts builds its own NextResponse from the same body and headers. */
export function curatorUnavailable(): Response {
    return new Response(UNAVAILABLE_HTML, { status: 503, headers: UNAVAILABLE_HEADERS });
}
