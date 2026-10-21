import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import GlobalError from '../global-error';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock('@/app/fonts', () => ({
  serif: { variable: '' },
  sans: { variable: '' },
}));

describe('app/global-error', () => {
  // <html> can't mount inside a test container, so this checks the markup.
  const markup = renderToStaticMarkup(<GlobalError error={new Error('boom')} reset={vi.fn()} />);
  const page = new DOMParser().parseFromString(markup, 'text/html');

  it('brings its own html and body, in the dark theme', () => {
    expect(markup.startsWith('<html')).toBe(true);
    expect(page.documentElement.getAttribute('lang')).toBe('en');
    expect(page.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(page.body).not.toBeNull();
  });

  it('shows the heading, Try again, and a link home, and no SiteNav', () => {
    expect(page.querySelector('h1')?.textContent).toBe('Something went wrong');
    expect(Array.from(page.querySelectorAll('button')).map((button) => button.textContent)).toEqual(['Try again']);
    expect(page.querySelector('a[href="/"]')).not.toBeNull();
    expect(page.querySelector('nav')).toBeNull();
  });

  it('never shows the error message', () => {
    expect(markup).not.toContain('boom');
  });
});
