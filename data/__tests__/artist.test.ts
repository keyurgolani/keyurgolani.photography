// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
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

describe('artist.profile', () => {
  const { profile } = artist;

  it('stays provisional until the owner approves the copy', () => {
    // The owner's copy commit flips this, along with the heading, paragraphs, alias, alt text, and any biography.
    expect(profile.copyStatus).toBe('provisional');
  });

  it('leaves out the claim that the work is edited and sequenced, which is false before the catalog cutover', () => {
    const copy = [profile.statementHeading, ...profile.statementParagraphs, profile.shortBiography ?? ''].join(' ');
    expect(copy).not.toMatch(/edited and sequenced/i);
  });

  it('has a heading, at least one paragraph, and no markup in any copy', () => {
    expect(profile.statementHeading.trim()).not.toBe('');
    expect(profile.statementParagraphs.length).toBeGreaterThan(0);
    for (const text of [profile.name, profile.alias ?? '', profile.statementHeading, ...profile.statementParagraphs, profile.shortBiography ?? '', profile.portrait?.alt ?? '']) {
      expect(text.trim(), 'empty copy').toBe(text);
      expect(text).not.toMatch(/[<>]/);
    }
  });

  it("gives the portrait the size of the PNG data/artistPortraitImage.ts imports, an alt, and a focal point inside the frame", () => {
    const { portrait } = profile;
    expect(portrait).toBeDefined();
    if (!portrait) return;
    const module = fs.readFileSync(path.join(import.meta.dirname, '../artistPortraitImage.ts'), 'utf8');
    const imported = /from '([^']+\.png)'/.exec(module)?.[1];
    expect(imported, 'data/artistPortraitImage.ts imports a .png').toBeDefined();
    // The PNG header: width and height are the big-endian words at bytes 16 and 20.
    const header = fs.readFileSync(path.join(import.meta.dirname, '..', imported ?? '')).subarray(0, 24);
    expect({ width: portrait.width, height: portrait.height }).toEqual({ width: header.readUInt32BE(16), height: header.readUInt32BE(20) });
    expect(portrait.alt.trim()).not.toBe('');
    for (const value of [portrait.focalPoint?.x ?? 50, portrait.focalPoint?.y ?? 50]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });
});
