/**
 * A page's HTML as the reflection checks read it: everything the site
 * renders, links and passes as props, without Next's own copy of the address
 * the page was served at.
 *
 * Next seeds the client router with the request URL in the flight stream's
 * root row (`0:{...}`), twice, and no product code writes either field
 * (next/dist/server/app-render/app-render.js, getRSCPayload()):
 *
 * - `c`, prepareInitialCanonicalUrl(): the path and query split on `/`, the
 *   query as URLSearchParams writes it;
 * - `q`, getRenderedSearch(): the query, each value through encodeURIComponent.
 *
 * The view is the markup without the `self.__next_f.push(...)` scripts, then
 * the flight stream they carry, decoded, one row per line. The root row is
 * parsed as JSON, and only `c` and `q` are deleted from it before it's written
 * back; every other row stays as it came. So a value in a link, a client prop
 * (any row, the root row included), or metadata still shows, and decoded,
 * where an HTML-escaped form would hide it.
 *
 * It throws unless both fields are there and hold exactly the URL for
 * `pathname` and `query`, so a Next upgrade that moves or rewrites them fails
 * the check loudly instead of letting it pass on a field it no longer finds.
 */
export function withoutRequestUrl(html: string, pathname: string, query: Record<string, string>): string {
    const { markup, stream } = flightOf(html);
    const rows = rowsOf(stream);
    const roots = rows.filter((row) => row.id === '0');
    if (roots.length !== 1) throw new Error(`Expected one root flight row (0:), found ${roots.length}`);
    const root: unknown = JSON.parse(roots[0].text);
    if (root === null || typeof root !== 'object' || Array.isArray(root)) throw new Error('The root flight row is not a JSON object');
    const fields = root as Record<string, unknown>;

    const search = new URLSearchParams(query).toString();
    const rendered = Object.entries(query)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
    expectField(fields, 'c', `${pathname}${search ? `?${search}` : ''}`.split('/'));
    expectField(fields, 'q', rendered ? `?${rendered}` : '');
    delete fields.c;
    delete fields.q;

    const flight = rows.map((row) => `${row.id}:${row === roots[0] ? JSON.stringify(fields) : row.text}`).join('\n');
    return `${markup}\n${flight}`;
}

function expectField(fields: Record<string, unknown>, name: string, expected: unknown): void {
    if (!(name in fields)) throw new Error(`The root flight row has no ${name} field, so Next no longer writes the request URL there`);
    const held = JSON.stringify(fields[name]);
    if (held !== JSON.stringify(expected)) throw new Error(`The root flight row's ${name} field holds ${held}, not the request URL ${JSON.stringify(expected)}`);
}

/** Next's flight scripts: one `self.__next_f.push(<JSON array>)` each, written by JSON.stringify and htmlEscapeJsonString. */
const FLIGHT_SCRIPT = /<script\b[^>]*>self\.__next_f\.push\(([\s\S]*?)\)<\/script>/g;

/** The markup without the flight scripts, and the bytes of the stream they carry, in order. */
function flightOf(html: string): { markup: string; stream: Buffer } {
    const chunks: Buffer[] = [];
    let found = 0;
    const markup = html.replace(FLIGHT_SCRIPT, (_script, args: string) => {
        found++;
        const push: unknown = JSON.parse(args);
        if (!Array.isArray(push)) throw new Error(`A flight script pushes ${args.slice(0, 40)}, not an array`);
        // 1 is a text chunk and 3 a base64 one. 0 (bootstrap) and 2 (form state) aren't the stream, so they stay in the view as they are.
        if (push[0] === 1 && typeof push[1] === 'string') chunks.push(Buffer.from(push[1], 'utf8'));
        else if (push[0] === 3 && typeof push[1] === 'string') chunks.push(Buffer.from(push[1], 'base64'));
        else return `<!-- flight ${JSON.stringify(push)} -->`;
        return '';
    });
    if (found === 0) throw new Error('The page has no flight scripts (self.__next_f.push), so its root row cannot be read');
    return { markup, stream: Buffer.concat(chunks) };
}

interface FlightRow {
    id: string;
    text: string;
}

/** Tags of rows that carry a hex byte length and a comma, then that many bytes, with no newline after: text, and binary arrays. */
const LENGTH_TAGS = new Set('TAOoUSsLlGgMmV');
const COLON = 0x3a;
const COMMA = 0x2c;
const NEWLINE = 0x0a;

/** The stream's rows, as React's client reads them: `<hex id>:<row>`, ended by a newline unless length-prefixed. A hint row (`:HL[...]`) has no id. */
function rowsOf(stream: Buffer): FlightRow[] {
    const rows: FlightRow[] = [];
    let at = 0;
    while (at < stream.length) {
        const colon = stream.indexOf(COLON, at);
        if (colon === -1) throw new Error(`A flight row at byte ${at} has no id`);
        const id = stream.toString('utf8', at, colon);
        if (!/^[0-9a-f]*$/.test(id)) throw new Error(`A flight row at byte ${at} has the id ${JSON.stringify(id.slice(0, 20))}`);
        const tag = String.fromCharCode(stream[colon + 1]);
        const comma = stream.indexOf(COMMA, colon + 2);
        const length = comma === -1 ? '' : stream.toString('utf8', colon + 2, comma);
        if (LENGTH_TAGS.has(tag) && /^[0-9a-f]+$/.test(length)) {
            const end = comma + 1 + parseInt(length, 16);
            if (end > stream.length) throw new Error(`Flight row ${id} runs past the end of the stream`);
            rows.push({ id, text: `${tag}${length},${stream.toString('utf8', comma + 1, end)}` });
            at = end;
            continue;
        }
        const newline = stream.indexOf(NEWLINE, colon + 1);
        const end = newline === -1 ? stream.length : newline;
        rows.push({ id, text: stream.toString('utf8', colon + 1, end) });
        at = end + 1;
    }
    return rows;
}
