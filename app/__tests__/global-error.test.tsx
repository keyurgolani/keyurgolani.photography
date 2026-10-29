import { act, fireEvent, render, screen } from '@testing-library/react';
import { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { THEME_INIT_SCRIPT } from '@/components/site/themeScript';
import GlobalError from '../global-error';

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
/** Whether a startTransition callback is running, so a call can record that it ran inside one. */
const transition = vi.hoisted(() => ({ inside: false }));

vi.mock('next/navigation', () => ({
  useRouter: () => router,
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    startTransition: (callback: () => void) =>
      actual.startTransition(() => {
        transition.inside = true;
        try {
          callback();
        } finally {
          transition.inside = false;
        }
      }),
  };
});

vi.mock('@/app/fonts', () => ({
  serif: { variable: '' },
  sans: { variable: '' },
}));

const failure = Object.assign(new Error('ENOENT: no such file, /srv/photos/catalog.json'), { digest: '2315104823' });

/** The `actions` the page hands StatusPage, found in the tree it returns. */
const findActions = (node: ReactNode): ReactNode => {
  if (!isValidElement<{ actions?: ReactNode; children?: ReactNode }>(node)) return null;
  return node.props.actions ?? Children.toArray(node.props.children).map(findActions).find((found) => found != null) ?? null;
};

/** <html> can't mount inside a test container, so this renders only the page's actions, with its hooks. */
function Actions(props: Parameters<typeof GlobalError>[0]) {
  return <>{findActions(GlobalError(props))}</>;
}

describe('app/global-error', () => {
  // <html> can't mount inside a test container, so this checks the markup.
  const markup = renderToStaticMarkup(<GlobalError error={failure} reset={vi.fn()} />);
  const page = new DOMParser().parseFromString(markup, 'text/html');

  it('brings its own html and body, in System painting Black, as the root layout sends, with the theme script', () => {
    expect(markup.startsWith('<html')).toBe(true);
    expect(page.documentElement.getAttribute('lang')).toBe('en');
    expect(page.documentElement.getAttribute('data-theme')).toBe('black');
    expect(page.documentElement.getAttribute('data-theme-choice')).toBe('system');
    expect(markup).toContain(`<script>${THEME_INIT_SCRIPT}</script>`);
    expect(page.body).not.toBeNull();
  });

  it('shows the heading, Try again, and a link home, and no SiteNav', () => {
    expect(page.querySelector('h1')?.textContent).toBe('Something went wrong');
    expect(Array.from(page.querySelectorAll('button')).map((button) => button.textContent)).toEqual(['Try again']);
    expect(page.querySelector('a[href="/"]')).not.toBeNull();
    expect(page.querySelector('nav')).toBeNull();
  });

  it('never shows the message, the digest, or a path', () => {
    expect(markup).not.toContain('ENOENT');
    expect(markup).not.toContain('/srv/photos');
    expect(markup).not.toContain(failure.digest);
  });

  it('refreshes the route and resets the boundary in one transition on Try again', () => {
    const calls: string[] = [];
    router.refresh.mockImplementation(() => calls.push(`refresh ${transition.inside ? 'inside' : 'outside'}`));
    const reset = vi.fn(() => calls.push(`reset ${transition.inside ? 'inside' : 'outside'}`));
    render(<Actions error={failure} reset={reset} />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Try again' })));
    expect(calls).toEqual(['refresh inside', 'reset inside']);
  });
});
