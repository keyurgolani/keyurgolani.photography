// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { artist, EXTERNAL_DESTINATION_ICONS, type ExternalDestinationIcon } from '../artist';

const { destinations } = artist;

describe('artist.destinations', () => {
  it('keeps the authored order', () => {
    expect(destinations.map((destination) => destination.id)).toEqual(['instagram', '500px', 'flickr', 'site-source']);
  });

  it('has unique kebab-case ids and a label on every entry', () => {
    const ids = destinations.map((destination) => destination.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { id, label } of destinations) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(label.trim(), id).not.toBe('');
    }
  });

  it('gives every profile and the repository an icon and a plain https: href', () => {
    const linked = destinations.filter((destination) => destination.kind === 'profile' || destination.kind === 'repository');
    expect(linked.length).toBeGreaterThan(0);
    for (const { id, href, icon } of linked) {
      expect(icon, id).toBeDefined();
      const url = new URL(href);
      expect(url.protocol, id).toBe('https:');
      expect(url.search, `${id} has a query string`).toBe('');
      expect(url.hash, `${id} has a fragment`).toBe('');
      expect(href, `${id} has an empty query or fragment`).not.toMatch(/[?#]/);
    }
  });

  it('links each profile and the repository to its own known host', () => {
    const hosts: Record<ExternalDestinationIcon, string> = {
      instagram: 'www.instagram.com',
      '500px': '500px.com',
      flickr: 'www.flickr.com',
      github: 'github.com',
    };
    for (const { id, kind, href, icon } of destinations) {
      if (kind === 'contact') continue;
      expect(icon, id).toBeDefined();
      const url = new URL(href);
      expect(url.host, id).toBe(hosts[icon as ExternalDestinationIcon]);
      expect(url.username + url.password, `${id} has credentials`).toBe('');
    }
  });

  it('gives any contact a mailto: href', () => {
    for (const { id, href } of destinations.filter((destination) => destination.kind === 'contact')) {
      expect(new URL(href).protocol, id).toBe('mailto:');
    }
  });

  it('uses only icons ExternalLinkIcon draws', () => {
    for (const { id, icon } of destinations) {
      if (icon !== undefined) expect(EXTERNAL_DESTINATION_ICONS, id).toContain(icon);
    }
  });
});
