import { describe, expect, it } from 'vitest';
import { currentSection, NAV_ITEMS } from '../nav';

describe('NAV_ITEMS', () => {
  it('lists Home, Work, and About in order, with Work on /gallery until #3', () => {
    expect(NAV_ITEMS).toEqual([
      { section: 'home', label: 'Home', href: '/' },
      { section: 'work', label: 'Work', href: '/gallery' },
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
});
