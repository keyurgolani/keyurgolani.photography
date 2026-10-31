import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ErrorPage from '../error';

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

// The full nav, which the page loads lazily: marked, so a test can tell it from StaticSiteNav.
vi.mock('@/components/site/SiteNav', () => ({
  default: () => <nav aria-label="Primary" data-full-nav="" />,
}));

const failure = Object.assign(new Error('ENOENT: no such file, /srv/photos/catalog.json'), { digest: '2315104823' });

describe('app/error', () => {
  beforeEach(() => {
    router.refresh.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the static nav at once, then SiteNav once it loads, before the heading, and says the page did not load', async () => {
    const { container } = render(<ErrorPage error={failure} reset={vi.fn()} />);
    // At once: the static nav, a way home with no theme menu, where SiteNav will stand (#132's review, M2).
    expect(screen.getByRole('link', { name: 'KG, Keyur Golani' })).toHaveAttribute('href', '/');
    for (const [name, href] of [['Home', '/'], ['Work', '/work'], ['About', '/about']]) expect(screen.getByRole('link', { name })).toHaveAttribute('href', href);
    await waitFor(() => expect(container.querySelector('[data-full-nav]')).not.toBeNull());
    expect(screen.getAllByRole('navigation', { name: 'Primary' })).toHaveLength(1);
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const heading = screen.getByRole('heading', { level: 1, name: 'Something went wrong' });
    expect(nav.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("This page didn't load. Try again in a moment.")).toBeInTheDocument();
  });

  it('never shows the message, the digest, or a path', () => {
    const { container } = render(<ErrorPage error={failure} reset={vi.fn()} />);
    expect(container.textContent).not.toContain('ENOENT');
    expect(container.textContent).not.toContain('/srv/photos');
    expect(container.textContent).not.toContain(failure.digest);
  });

  it('refreshes the route and resets the boundary in one transition on Try again', () => {
    const calls: string[] = [];
    router.refresh.mockImplementation(() => calls.push(`refresh ${transition.inside ? 'inside' : 'outside'}`));
    const reset = vi.fn(() => calls.push(`reset ${transition.inside ? 'inside' : 'outside'}`));
    render(<ErrorPage error={failure} reset={reset} />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Try again' })));
    expect(calls).toEqual(['refresh inside', 'reset inside']);
  });

  it('says so when the browser is offline', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(<ErrorPage error={failure} reset={vi.fn()} />);
    expect(screen.getByText("You're offline. Reconnect, then try again.")).toBeInTheDocument();
  });

  it('keeps the static nav when SiteNav fails to load, never falls through to global-error, and loads it on Try again', async () => {
    // #132's review, M1: offline, or a tab left open across a redeploy, the nav's chunk fails.
    vi.resetModules();
    vi.doMock('@/components/site/SiteNav', () => {
      throw new Error('chunk failed to load');
    });
    const { default: FreshErrorPage } = await import('../error');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { container } = render(<FreshErrorPage error={failure} reset={vi.fn()} />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.getByRole('heading', { level: 1, name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
    expect(container.querySelector('[data-full-nav]')).toBeNull();
    // The load is tried again with the page.
    vi.doMock('@/components/site/SiteNav', () => ({ default: () => <nav aria-label="Primary" data-full-nav="" /> }));
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Try again' })));
    await waitFor(() => expect(container.querySelector('[data-full-nav]')).not.toBeNull());
    quiet.mockRestore();
    vi.doUnmock('@/components/site/SiteNav');
  });
});
