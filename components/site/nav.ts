import { createRouteBuilder, stripBasePath, type RouteBuilder } from '@/lib/catalog/routes';

export type NavSection = 'home' | 'work' | 'about';

export interface NavItem {
  section: NavSection;
  label: string;
  href: string;
}

/**
 * The Primary links, in order, with hrefs from the site's RouteBuilder: the
 * public one by default, or #16's preview builder, so the links stay inside
 * the preview. Work points at /work in both modes: before the catalog
 * cutover /work answers 307 to the legacy /gallery, and after it /gallery
 * answers 308 to /work (#3).
 */
export function navItems(routes: Pick<RouteBuilder, 'homeHref' | 'workHref' | 'aboutHref'> = createRouteBuilder()): readonly NavItem[] {
  return [
    { section: 'home', label: 'Home', href: routes.homeHref() },
    { section: 'work', label: 'Work', href: routes.workHref() },
    { section: 'about', label: 'About', href: routes.aboutHref() },
  ];
}

/** The public site's Primary links. */
export const NAV_ITEMS: readonly NavItem[] = navItems();

/**
 * The section `pathname` belongs to, or `null` for any other path, `/workshop`
 * and `/about-me` included. Under a `basePath` (#16's preview) the path is
 * read without it, and a path outside it belongs to nothing.
 */
export function currentSection(pathname: string, basePath = ''): NavSection | null {
  const path = stripBasePath(pathname, basePath);
  if (path === null) return null;
  if (path === '/') return 'home';
  if (path === '/gallery' || path === '/work' || path.startsWith('/work/')) return 'work';
  if (path === '/about') return 'about';
  return null;
}
