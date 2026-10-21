export type NavSection = 'home' | 'work' | 'about';

export interface NavItem {
  section: NavSection;
  label: string;
  href: string;
}

/** The Primary links, in order. Work points at /gallery until #3 (series catalog) switches it to /work. */
export const NAV_ITEMS: readonly NavItem[] = [
  { section: 'home', label: 'Home', href: '/' },
  { section: 'work', label: 'Work', href: '/gallery' },
  { section: 'about', label: 'About', href: '/about' },
];

/** The section `pathname` belongs to, or `null` for any other path, `/workshop` and `/about-me` included. */
export function currentSection(pathname: string): NavSection | null {
  if (pathname === '/') return 'home';
  if (pathname === '/gallery' || pathname === '/work' || pathname.startsWith('/work/')) return 'work';
  if (pathname === '/about') return 'about';
  return null;
}
