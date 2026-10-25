import { describe, expect, it } from 'vitest';
import { createRouteBuilder } from '@/lib/catalog/routes';
import { currentSection, NAV_ITEMS, navItems } from '../nav';

describe('NAV_ITEMS', () => {
  it('lists Home, Work, and About in order, with Work on /work, which serves both modes', () => {
    expect(NAV_ITEMS).toEqual([
      { section: 'home', label: 'Home', href: '/' },
      { section: 'work', label: 'Work', href: '/work' },
      { section: 'about', label: 'About', href: '/about' },
    ]);
  });
});

describe('currentSection', () => {
  it.each([
    ['/', 'home'],
    ['/gallery', 'work'],
    ['/work', 'work'],
    ['/work/streets', 'work'],
    ['/work/streets/photo-1', 'work'],
    ['/about', 'about'],
  ] as const)('puts %s under %s', (pathname, section) => {
    expect(currentSection(pathname)).toBe(section);
  });

  it.each(['/workshop', '/about-me', '/gallery/extra', '/does-not-exist', ''])('puts %s under nothing', (pathname) => {
    expect(currentSection(pathname)).toBeNull();
  });

  const base = `/curation/preview/rev_${'a'.repeat(64)}/site`;

  it.each([
    [base, 'home'],
    [`${base}/work`, 'work'],
    [`${base}/work/streets/photo/ph_1`, 'work'],
    [`${base}/about`, 'about'],
  ] as const)("reads %s without #16's preview base path, under %s", (pathname, section) => {
    expect(currentSection(pathname, base)).toBe(section);
  });

  it.each(['/', '/work', `${base}x/work`, '/curation/preview', `${base}/workshop`])('puts %s, outside the preview or its sections, under nothing', (pathname) => {
    expect(currentSection(pathname, base)).toBeNull();
  });
});

describe('navItems', () => {
  it("builds the same links under #16's preview base path", () => {
    const base = `/curation/preview/rev_${'a'.repeat(64)}/site`;
    expect(navItems(createRouteBuilder({ basePath: base })).map((item) => item.href)).toEqual([base, `${base}/work`, `${base}/about`]);
    expect(navItems()).toEqual(NAV_ITEMS);
  });
});
