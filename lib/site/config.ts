// The site's public origin. SITE_URL is read on every call, never inlined at
// build time, so one image can serve any origin. CI builds without it.

/** What share URLs fall back to without a valid SITE_URL, as Next would. */
const LOCAL_ORIGIN = 'http://localhost:3000';

/**
 * Reads `SITE_URL` and returns its origin, or why it has none. The reason
 * never quotes the value, which may hold credentials.
 */
function readSiteUrl(): { origin: URL } | { problem: string } {
  const value = process.env.SITE_URL?.trim();
  if (!value) return { problem: "SITE_URL isn't set" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { problem: "SITE_URL isn't an absolute URL" };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { problem: "SITE_URL's scheme isn't http or https" };
  if (url.username || url.password) return { problem: 'SITE_URL has credentials' };
  if (url.pathname !== '/') return { problem: 'SITE_URL has a path' };
  if (url.search) return { problem: 'SITE_URL has a query' };
  if (url.hash) return { problem: 'SITE_URL has a hash' };
  return { origin: new URL(url.origin) };
}

/**
 * The origin in `SITE_URL`: an absolute http or https URL with no path beyond
 * `/`, and no query, hash, or credentials. A trailing slash is dropped.
 * Returns `null` for anything else, and `getMetadataBase()` then falls back
 * to `http://localhost:3000`.
 */
export function getSiteOrigin(): URL | null {
  const read = readSiteUrl();
  return 'origin' in read ? read.origin : null;
}

/** The base for metadata URLs, `SITE_URL`'s origin or the local fallback. */
export function getMetadataBase(): URL {
  return getSiteOrigin() ?? new URL(LOCAL_ORIGIN);
}

let warned = false;

/** Warns once, with the reason and never the value, when a production server starts without a valid `SITE_URL`. */
export function checkSiteUrl(): void {
  if (warned || process.env.NODE_ENV !== 'production') return;
  const read = readSiteUrl();
  if ('origin' in read) return;
  warned = true;
  console.warn(`${read.problem}, so share links point at ${LOCAL_ORIGIN}. Set it to the site's public origin, like https://keyurgolani.photography.`);
}
