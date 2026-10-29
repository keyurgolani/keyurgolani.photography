import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SiteNav from '../SiteNav';
import SiteRoutesProvider from '../SiteRoutes';

const navigation = vi.hoisted(() => ({ pathname: '/' }));

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
}));

vi.mock('@/components/ThemeMenu', () => ({
  default: () => <button type="button">Theme: System (Black now)</button>,
}));

const primary = () => screen.getByRole('navigation', { name: 'Primary' });

describe('SiteNav', () => {
  beforeEach(() => {
    navigation.pathname = '/';
  });

  it('holds the wordmark, Home, Work, About, and the theme control, in that order', () => {
    render(<SiteNav />);
    const names = Array.from(primary().querySelectorAll('a, button')).map(
      (element) => element.getAttribute('aria-label') ?? element.textContent,
    );
    expect(names).toEqual(['KG, Keyur Golani', 'Home', 'Work', 'About', 'Theme: System (Black now)']);
    expect(within(primary()).getByRole('link', { name: 'KG, Keyur Golani' })).toHaveTextContent(/^KG/);
  });

  it('keeps the wordmark text as separate words, so its visible label sits inside its name', () => {
    render(<SiteNav />);
    // Without the space the text reads "KGKeyur Golani", which axe's label-content-name-mismatch fails.
    expect(within(primary()).getByRole('link', { name: 'KG, Keyur Golani' }).textContent).toBe('KG Keyur Golani');
  });

  it.each([
    ['/', 'Home'],
    ['/gallery', 'Work'],
    ['/work', 'Work'],
    ['/work/streets', 'Work'],
    ['/about', 'About'],
  ])('marks the current page on %s', (pathname, current) => {
    navigation.pathname = pathname;
    render(<SiteNav />);
    const marked = within(primary())
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page')
      .map((link) => link.textContent);
    expect(marked).toEqual([current]);
  });

  it('marks nothing on a path outside the sections', () => {
    navigation.pathname = '/does-not-exist';
    render(<SiteNav />);
    expect(within(primary()).getAllByRole('link').filter((link) => link.hasAttribute('aria-current'))).toEqual([]);
  });

  it('links Work to /work, never the legacy /gallery, and the wordmark to /', () => {
    render(<SiteNav />);
    expect(within(primary()).getByRole('link', { name: 'Work' })).toHaveAttribute('href', '/work');
    expect(primary().querySelector('a[href="/gallery"]')).toBeNull();
    expect(within(primary()).getByRole('link', { name: 'KG, Keyur Golani' })).toHaveAttribute('href', '/');
  });

  it("keeps every link inside #16's preview, and marks the section under its base path", () => {
    const base = `/curation/preview/rev_${'a'.repeat(64)}/site`;
    navigation.pathname = `${base}/work/streets`;
    render(
      <SiteRoutesProvider basePath={base}>
        <SiteNav />
      </SiteRoutesProvider>,
    );
    const links = within(primary()).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([base, base, `${base}/work`, `${base}/about`]);
    expect(links.filter((link) => link.getAttribute('aria-current') === 'page').map((link) => link.textContent)).toEqual(['Work']);
  });

  it('puts data-surface="about" on the nav only for the paper variant', () => {
    const { unmount } = render(<SiteNav />);
    expect(primary()).not.toHaveAttribute('data-surface');
    unmount();
    render(<SiteNav surface="gallery" />);
    expect(primary()).not.toHaveAttribute('data-surface');
  });

  it('paints the paper variant with surface="about"', () => {
    render(<SiteNav surface="about" />);
    expect(primary()).toHaveAttribute('data-surface', 'about');
  });
});
