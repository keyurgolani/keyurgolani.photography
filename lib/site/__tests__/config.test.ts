// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function load(siteUrl: string | undefined, nodeEnv = 'production') {
  vi.resetModules();
  if (siteUrl === undefined) vi.stubEnv('SITE_URL', undefined);
  else vi.stubEnv('SITE_URL', siteUrl);
  vi.stubEnv('NODE_ENV', nodeEnv);
  return import('../config');
}

describe('lib/site/config', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('takes a valid origin', async () => {
    const { getSiteOrigin, getMetadataBase } = await load('https://example.test');
    expect(getSiteOrigin()?.href).toBe('https://example.test/');
    expect(getMetadataBase().href).toBe('https://example.test/');
  });

  it.each(['https://example.test', 'https://example.test/'])('takes %s with or without a trailing slash as the same origin', async (value) => {
    const { getSiteOrigin, getMetadataBase } = await load(value);
    expect(getSiteOrigin()?.href).toBe('https://example.test/');
    expect(getMetadataBase().href).toBe('https://example.test/');
  });

  const INVALID = [
    ['a path', 'https://example.test/photos', /^SITE_URL has a path,/],
    ['a query', 'https://example.test/?a=1', /^SITE_URL has a query,/],
    ['a hash', 'https://example.test/#top', /^SITE_URL has a hash,/],
    ['a non-http scheme', 'ftp://example.test', /^SITE_URL's scheme isn't http or https,/],
    ['no scheme', 'example.test', /^SITE_URL isn't an absolute URL,/],
    ['credentials', 'https://user:secret@example.test', /^SITE_URL has credentials,/],
    ['a username alone', 'https://user@example.test', /^SITE_URL has credentials,/],
  ] as const;

  it.each(INVALID)('rejects %s', async (_, value) => {
    const { getSiteOrigin, getMetadataBase } = await load(value);
    expect(getSiteOrigin()).toBeNull();
    expect(getMetadataBase().href).toBe('http://localhost:3000/');
  });

  it.each(INVALID)('warns about %s by its reason, never its value', async (_, value, reason) => {
    const { checkSiteUrl } = await load(value);
    checkSiteUrl();
    const [message] = vi.mocked(console.warn).mock.calls[0];
    expect(message).toMatch(reason);
    expect(message).not.toContain(value);
    expect(message).not.toMatch(/user|secret|photos|a=1|top/);
  });

  it('warns that SITE_URL is unset without a value', async () => {
    const { checkSiteUrl } = await load(undefined);
    checkSiteUrl();
    expect(vi.mocked(console.warn).mock.calls[0][0]).toMatch(/^SITE_URL isn't set, so share links point at http:\/\/localhost:3000\./);
  });

  it('falls back to localhost without a value', async () => {
    const { getSiteOrigin, getMetadataBase } = await load(undefined);
    expect(getSiteOrigin()).toBeNull();
    expect(getMetadataBase().href).toBe('http://localhost:3000/');
  });

  it('reads SITE_URL on each call', async () => {
    const { getSiteOrigin } = await load(undefined);
    expect(getSiteOrigin()).toBeNull();
    vi.stubEnv('SITE_URL', 'https://later.test');
    expect(getSiteOrigin()?.origin).toBe('https://later.test');
  });

  it('warns once in production when the value is missing or invalid', async () => {
    const { checkSiteUrl } = await load('not a url');
    checkSiteUrl();
    checkSiteUrl();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0][0]).toMatch(/SITE_URL/);
  });

  it('stays quiet with a valid value, and outside production', async () => {
    const valid = await load('https://example.test');
    valid.checkSiteUrl();
    const development = await load(undefined, 'development');
    development.checkSiteUrl();
    expect(console.warn).not.toHaveBeenCalled();
  });
});
