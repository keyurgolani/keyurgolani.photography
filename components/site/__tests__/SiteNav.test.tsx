import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SiteNav from '../SiteNav';

const navigation = vi.hoisted(() => ({ pathname: '/' }));

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
}));

vi.mock('@/components/ThemeToggle', () => ({
  default: () => <button type="button">Switch to light mode</button>,
}));

const primary = () => screen.getByRole('navigation', { name: 'Primary' });

describe('SiteNav', () => {
  beforeEach(() => {
    navigation.pathname = '/';
  });

  it('holds the wordmark, Home, Work, About, and the toggle, in that order', () => {
    render(<SiteNav />);
    const names = Array.from(primary().querySelectorAll('a, button')).map(
      (element) => element.getAttribute('aria-label') ?? element.textContent,
    );
    expect(names).toEqual(['KG, Keyur Golani', 'Home', 'Work', 'About', 'Switch to light mode']);
    expect(within(primary()).getByRole('link', { name: 'KG, Keyur Golani' })).toHaveTextContent(/^KG/);
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

  it('links Work to /gallery and the wordmark to /', () => {
    render(<SiteNav />);
    expect(within(primary()).getByRole('link', { name: 'Work' })).toHaveAttribute('href', '/gallery');
    expect(within(primary()).getByRole('link', { name: 'KG, Keyur Golani' })).toHaveAttribute('href', '/');
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
