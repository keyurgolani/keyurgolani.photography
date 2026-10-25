export type NavSection = 'home' | 'work' | 'about';

export interface NavItem {
  section: NavSection;
  label: string;
  href: string;
}

/**
 * The Primary links, in order. Work points at /work in both modes: before the
 * catalog cutover /work answers 307 to the legacy /gallery, and after it
 * /gallery answers 308 to /work (#3).
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { section: 'home', label: 'Home', href: '/' },
  { section: 'work', label: 'Work', href: '/work' },
  { section: 'about', label: 'About', href: '/about' },
];

/** The section `pathname` belongs to, or `null` for any other path, `/workshop` and `/about-me` included. */
export function currentSection(pathname: string): NavSection | null {
  if (pathname === '/') return 'home';
  if (pathname === '/gallery' || pathname === '/work' || pathname.startsWith('/work/')) return 'work';
  if (pathname === '/about') return 'about';
  return null;
}
