import { act, fireEvent, render, screen } from '@testing-library/react';
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

vi.mock('@/components/site/SiteNav', () => ({
  default: () => <nav aria-label="Primary" />,
}));

const failure = Object.assign(new Error('ENOENT: no such file, /srv/photos/catalog.json'), { digest: '2315104823' });

describe('app/error', () => {
  beforeEach(() => {
    router.refresh.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders SiteNav, loaded with the page, before the heading and says the page did not load', async () => {
    render(<ErrorPage error={failure} reset={vi.fn()} />);
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
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
});
