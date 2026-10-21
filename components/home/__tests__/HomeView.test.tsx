import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mediaListenerCounts, setPrefersReducedMotion } from '@/test/matchMedia';
import type { HomePhoto } from '../homePhoto';
import { HOME_AUTO_ADVANCE_MS } from '../homePlayback';

const chrome = vi.hoisted(() => ({ show: (() => {}) as (visible: boolean) => void }));

// Settles once the first photograph is ready, like the real intro without its timers.
vi.mock('@/components/HeroReveal', async () => {
  const { useEffect } = await import('react');
  return {
    default: function HeroReveal({ isLoading, onSettled }: { isLoading: boolean; onSettled: () => void }) {
      useEffect(() => {
        if (!isLoading) onSettled();
      }, [isLoading, onSettled]);
      return <div data-testid="hero-reveal" data-loading={String(isLoading)} />;
    },
  };
});

// The chrome is hidden until a test shows it.
vi.mock('@/components/RevealingContents', () => ({
  default: ({ children, onVisibleChange }: { children: React.ReactNode; onVisibleChange?: (visible: boolean) => void }) => {
    chrome.show = (visible) => onVisibleChange?.(visible);
    return <div data-testid="chrome">{children}</div>;
  },
}));

vi.mock('@/components/BottomBar', () => ({
  default: () => <div data-testid="bottom-bar" />,
}));

const photo = (n: number, total: number): HomePhoto => ({
  id: `/original-${n}.jpg`,
  accessibleName: `Photograph ${n} of ${total}`,
  sources: { thumbnail: `/thumb-${n}.webp`, full: `/optimized-${n}.webp` },
  width: 1200,
  height: 800,
});

const three = [photo(1, 3), photo(2, 3), photo(3, 3)];

async function renderHome({ photos = three, outside = false }: { photos?: HomePhoto[]; outside?: boolean } = {}) {
  const { default: HomeView } = await import('../HomeView');
  const view = render(
    <StrictMode>
      {outside && <button type="button">Outside</button>}
      <HomeView photos={photos} />
    </StrictMode>
  );
  const playback = () => view.container.querySelector('main')?.getAttribute('data-playback');
  const loading = () => screen.getByTestId('hero-reveal').getAttribute('data-loading');
  // The first photograph's full-quality layer loading ends the intro.
  const becomeReady = () =>
    act(() => {
      fireEvent.load(view.container.querySelector('[aria-hidden="false"] > img[data-layer="optimized"]')!);
    });
  return { ...view, playback, loading, becomeReady };
}

const button = (name: string) => screen.getByRole('button', { name });
const queryButton = (name: string) => screen.queryByRole('button', { name });
const position = () => screen.getByRole('group', { name: 'Slideshow' }).querySelector('span')?.textContent;
const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

/** Makes `element` match :focus-visible or not, the way a keyboard or a mouse focus would. */
function focusVisible(element: Element, result: boolean | 'throws') {
  const matches = element.matches.bind(element);
  vi.spyOn(element, 'matches').mockImplementation((selector: string) => {
    if (selector !== ':focus-visible') return matches(selector);
    if (result === 'throws') throw new SyntaxError(':focus-visible is not supported');
    return result;
  });
}

describe('HomeView', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stays in loading mode until the first photograph reports ready, then advances a full interval later', async () => {
    const { loading, playback, becomeReady } = await renderHome();
    expect(loading()).toBe('true');
    expect(playback()).toBe('not-ready');

    advance(5000);
    expect(loading()).toBe('true');
    expect(position()).toBe('01 / 03');

    becomeReady();
    expect(loading()).toBe('false');
    expect(playback()).toBe('advancing');
    advance(HOME_AUTO_ADVANCE_MS - 1);
    expect(position()).toBe('01 / 03');
    advance(1);
    expect(position()).toBe('02 / 03');
  });

  it('skips loading mode when returning home after the first photograph loaded', async () => {
    const first = await renderHome();
    first.becomeReady();
    first.unmount();

    const second = await renderHome();
    expect(second.loading()).toBe('false');
    expect(second.playback()).toBe('advancing');
  });

  it('with one photograph renders no controls and starts no timer', async () => {
    const { playback, becomeReady } = await renderHome({ photos: [photo(1, 1)] });
    becomeReady();
    advance(1000);

    expect(playback()).toBe('single');
    expect(screen.queryByRole('group', { name: 'Slideshow' })).toBeNull();
    expect(queryButton('Previous photograph')).toBeNull();
    expect(queryButton('Next photograph')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('names the playback button for what it will do, with no aria-pressed', async () => {
    const { playback, becomeReady } = await renderHome();
    becomeReady();

    const pause = button('Pause slideshow');
    expect(pause).toHaveTextContent('Pause');
    expect(pause).not.toHaveAttribute('aria-pressed');
    expect(pause).toHaveAttribute('type', 'button');

    fireEvent.click(pause);
    expect(playback()).toBe('paused');
    const play = button('Play slideshow');
    expect(play).toBe(pause);
    expect(play).toHaveTextContent('Play');
    expect(play).not.toHaveAttribute('aria-pressed');
    advance(HOME_AUTO_ADVANCE_MS * 3);
    expect(position()).toBe('01 / 03');

    fireEvent.click(play);
    expect(button('Pause slideshow')).toBe(pause);
    expect(playback()).toBe('advancing');
  });

  it('makes the arrows plain buttons, so they never submit a form around them', async () => {
    const { becomeReady } = await renderHome();
    becomeReady();

    for (const name of ['Previous photograph', 'Next photograph']) {
      expect(button(name)).toHaveAttribute('type', 'button');
    }
  });

  it('keeps focus on Next across a manual move', async () => {
    const { becomeReady } = await renderHome();
    becomeReady();
    const next = button('Next photograph');

    act(() => next.focus());
    fireEvent.click(next);

    expect(position()).toBe('02 / 03');
    expect(document.activeElement).toBe(next);
  });

  it('leaves focus outside the chrome where it was across an automatic move', async () => {
    const { becomeReady } = await renderHome({ outside: true });
    becomeReady();
    const outside = button('Outside');

    act(() => outside.focus());
    advance(HOME_AUTO_ADVANCE_MS);

    expect(position()).toBe('02 / 03');
    expect(document.activeElement).toBe(outside);
  });

  it('under reduce keeps the playback button in place, aria-disabled and described by the hint, and a click does nothing', async () => {
    setPrefersReducedMotion(true);
    const { playback, becomeReady } = await renderHome();
    becomeReady();

    expect(playback()).toBe('reduced-motion');
    const playbackButton = button('Play slideshow');
    expect(playbackButton).toHaveAttribute('aria-disabled', 'true');
    expect(playbackButton).not.toBeDisabled();
    expect(playbackButton).toHaveAccessibleDescription('Off with reduced motion');
    expect(screen.getByText('Off with reduced motion')).toBeVisible();

    fireEvent.click(playbackButton);
    expect(playback()).toBe('reduced-motion');
    expect(button('Play slideshow')).toBe(playbackButton);
    advance(HOME_AUTO_ADVANCE_MS * 3);
    expect(position()).toBe('01 / 03');

    // Direct navigation still works.
    fireEvent.click(button('Next photograph'));
    expect(position()).toBe('02 / 03');
  });

  it('leaving reduce restores the button and the slideshow', async () => {
    setPrefersReducedMotion(true);
    const { playback, becomeReady } = await renderHome();
    becomeReady();

    act(() => setPrefersReducedMotion(false));
    expect(playback()).toBe('advancing');
    const pause = button('Pause slideshow');
    expect(pause).not.toHaveAttribute('aria-disabled');
    expect(pause).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText('Off with reduced motion')).toBeNull();
  });

  it('a mouse or pen resting on the controls holds only while the chrome shows them, and touch never does', async () => {
    const { playback, becomeReady } = await renderHome();
    becomeReady();
    const group = screen.getByRole('group', { name: 'Slideshow' });

    fireEvent.pointerEnter(group, { pointerType: 'mouse' });
    expect(playback()).toBe('advancing');

    act(() => chrome.show(true));
    expect(playback()).toBe('held');
    expect(button('Pause slideshow')).toBeInTheDocument();
    advance(HOME_AUTO_ADVANCE_MS * 2);
    expect(position()).toBe('01 / 03');

    act(() => chrome.show(false));
    expect(playback()).toBe('advancing');
    act(() => chrome.show(true));
    expect(playback()).toBe('held');

    fireEvent.pointerLeave(group, { pointerType: 'mouse' });
    expect(playback()).toBe('advancing');

    fireEvent.pointerEnter(group, { pointerType: 'pen' });
    expect(playback()).toBe('held');
    fireEvent.pointerLeave(group, { pointerType: 'pen' });

    fireEvent.pointerEnter(group, { pointerType: 'touch' });
    expect(playback()).toBe('advancing');
  });

  it('keyboard focus inside the chrome holds, a mouse focus does not, and an unknown one counts as keyboard', async () => {
    const { playback, becomeReady } = await renderHome({ outside: true });
    becomeReady();
    const next = button('Next photograph');
    const pause = button('Pause slideshow');

    focusVisible(next, true);
    act(() => next.focus());
    expect(playback()).toBe('held');
    expect(button('Pause slideshow')).toBe(pause);
    advance(HOME_AUTO_ADVANCE_MS * 2);
    expect(position()).toBe('01 / 03');

    // Moving within the chrome keeps the hold, and leaving it ends the hold.
    focusVisible(pause, true);
    act(() => pause.focus());
    expect(playback()).toBe('held');
    act(() => button('Outside').focus());
    expect(playback()).toBe('advancing');

    vi.restoreAllMocks();
    focusVisible(next, false);
    act(() => next.focus());
    expect(playback()).toBe('advancing');

    act(() => button('Outside').focus());
    vi.restoreAllMocks();
    focusVisible(next, 'throws');
    act(() => next.focus());
    expect(playback()).toBe('held');
  });

  it('in Strict Mode, unmounting leaves no timers and balanced listeners', async () => {
    const counts = { added: 0, removed: 0 };
    for (const target of [document, window]) {
      const add = target.addEventListener.bind(target);
      const remove = target.removeEventListener.bind(target);
      vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
        if (type === 'visibilitychange' || type === 'pageshow') counts.added += 1;
        add(type, listener, options);
      });
      vi.spyOn(target, 'removeEventListener').mockImplementation((type, listener, options) => {
        if (type === 'visibilitychange' || type === 'pageshow') counts.removed += 1;
        remove(type, listener, options);
      });
    }
    const { becomeReady, unmount } = await renderHome();
    becomeReady();
    advance(HOME_AUTO_ADVANCE_MS);
    expect(position()).toBe('02 / 03');
    act(() => setPrefersReducedMotion(true));
    act(() => setPrefersReducedMotion(false));

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(counts.added).toBeGreaterThan(0);
    expect(counts.removed).toBe(counts.added);
    expect(mediaListenerCounts.added).toBeGreaterThan(0);
    expect(mediaListenerCounts.removed).toBe(mediaListenerCounts.added);
  });

  it('remembers a Pause across a remount in the tab, and a reload forgets it', async () => {
    const first = await renderHome();
    first.becomeReady();
    fireEvent.click(button('Pause slideshow'));
    first.unmount();

    const second = await renderHome();
    expect(second.playback()).toBe('paused');
    expect(button('Play slideshow')).toBeInTheDocument();
    second.unmount();

    // A fresh module graph is what a reload gives.
    vi.resetModules();
    const third = await renderHome();
    third.becomeReady();
    expect(button('Pause slideshow')).toBeInTheDocument();
    expect(third.playback()).toBe('advancing');
  });
});
