// The site's public origin. SITE_URL is read on every call, never inlined at
// build time, so one image can serve any origin. CI builds without it.

/** What share URLs fall back to without a valid SITE_URL, as Next would. */
const LOCAL_ORIGIN = 'http://localhost:3000';

/**
 * The origin in `SITE_URL`: an absolute http or https URL with no path beyond
 * `/`, and no query, hash, or credentials. A trailing slash is dropped.
 * Returns `null` for anything else, and callers then omit canonical and share
 * URLs.
 */
export function getSiteOrigin(): URL | null {
  const value = process.env.SITE_URL?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null;
  return new URL(url.origin);
}

/** The base for metadata URLs, `SITE_URL`'s origin or the local fallback. */
export function getMetadataBase(): URL {
  return getSiteOrigin() ?? new URL(LOCAL_ORIGIN);
}

let warned = false;

/** Warns once when a production server starts without a valid `SITE_URL`. */
export function checkSiteUrl(): void {
  if (warned || process.env.NODE_ENV !== 'production' || getSiteOrigin()) return;
  warned = true;
  const problem = process.env.SITE_URL?.trim() ? `SITE_URL (${process.env.SITE_URL}) isn't an http or https origin` : "SITE_URL isn't set";
  console.warn(`${problem}, so share links point at ${LOCAL_ORIGIN}. Set it to the site's public origin, like https://keyurgolani.photography.`);
}
