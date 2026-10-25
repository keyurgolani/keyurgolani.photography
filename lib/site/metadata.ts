export const SITE_NAME = 'Keyur Golani Photography';

/**
 * The site-wide Open Graph fields. Next replaces a nested metadata object
 * instead of merging it, so any page that sets `openGraph` spreads this first.
 */
export const siteOpenGraph = { siteName: SITE_NAME, type: 'website' } as const;
