import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ErrorPage from '../error';

const router = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => router,
}));

vi.mock('@/components/site/SiteNav', () => ({
  default: () => <nav aria-label="Primary" />,
}));

const failure = Object.assign(new Error('ENOENT: no such file, /srv/photos/catalog.json'), { digest: '2315104823' });

describe('app/error', () => {
  beforeEach(() => {
    router.refresh.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders SiteNav before the heading and says the page did not load', () => {
    render(<ErrorPage error={failure} reset={vi.fn()} />);
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

  it('refreshes the route and resets the boundary on Try again', () => {
    const reset = vi.fn();
    render(<ErrorPage error={failure} reset={reset} />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Try again' })));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('says so when the browser is offline', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(<ErrorPage error={failure} reset={vi.fn()} />);
    expect(screen.getByText("You're offline. Reconnect, then try again.")).toBeInTheDocument();
  });
});
