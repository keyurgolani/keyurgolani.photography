/**
 * A page's HTML without Next's own copy of the address it was served at, so
 * a check for a reflected query value sees only what the site renders.
 *
 * The flight data's root row (`0:{...}`, in a `self.__next_f.push` string)
 * seeds the client router with the request URL twice, and no product code
 * writes either field (next/dist/server/app-render/app-render.js,
 * getRSCPayload()):
 *
 * - `c`, prepareInitialCanonicalUrl(): the path and query split on `/`, with
 *   the query as URLSearchParams writes it.
 * - `q`, getRenderedSearch(): the query again, each value through
 *   encodeURIComponent.
 *
 * Both are percent-encoded strings inside a script's JSON string, never
 * markup, and the browser already holds the same URL. Only those two exact
 * fields come out, so the same value anywhere else, a prop, a link, metadata
 * or the rendered page, still shows.
 */
export function withoutRequestUrl(html: string, pathname: string, query: Record<string, string>): string {
    // In the HTML the flight row sits inside a JS string, so each JSON quote is written \".
    const quoted = (json: string) => json.replaceAll('"', '\\"');
    const search = new URLSearchParams(query).toString();
    const rendered = Object.entries(query)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
    const c = quoted(`"c":${JSON.stringify(`${pathname}${search ? `?${search}` : ''}`.split('/'))}`);
    const q = quoted(`"q":${JSON.stringify(rendered ? `?${rendered}` : '')}`);
    return html.replaceAll(c, '').replaceAll(q, '');
}
