import path from 'node:path';

/**
 * The site config folder: files the owner keeps on the host, beside
 * `docker-compose.prod.yml`, outside the image and the repository. Today it
 * holds About's portrait only (`about/portrait.*`, lib/siteConfig/aboutPortrait.ts).
 *
 * `PHOTOGRAPHY_SITE_CONFIG_DIR`, or `site-config` under the working
 * directory. The production compose file mounts the host's `./site-config`
 * read-only at `/config/site` and sets the variable to it. Resolved on every
 * call, like the data root, so tests can repoint it.
 *
 * Only the server reads it, and only the fixed names its readers ask for: no
 * request ever names a path in it.
 */
export const SITE_CONFIG_ENV = 'PHOTOGRAPHY_SITE_CONFIG_DIR';

export function siteConfigDir(): string {
    const configured = process.env[SITE_CONFIG_ENV];
    return path.resolve(/*turbopackIgnore: true*/ configured || path.join(/*turbopackIgnore: true*/ process.cwd(), 'site-config'));
}
