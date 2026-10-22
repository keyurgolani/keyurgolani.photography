import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mediaListenerCounts, setPrefersReducedMotion } from '@/test/matchMedia';
import { HOME_CHROME_FADE_MS, HOME_CHROME_IDLE_MS, HOME_LOADING_TIMEOUT_MS } from '../homeChromeConfig';
import type { HomePhoto } from '../homePhoto';
import { HOME_AUTO_ADVANCE_MS } from '../homePlayback';
import type { HomePhotosStatus } from '../useLegacyHomePhotos';

/** With `manual` set, the intro settles only when a test calls `settle`, after loading ends. */
const intro = vi.hoisted(() => ({ manual: false, settle: () => {} }));

// Like the real intro without its timers: loading while Home loads, revealing after, then settled.
vi.mock('@/components/HeroReveal', async () => {
  const { useEffect, useState } = await import('react');
  return {
    default: function HeroReveal({
      isLoading,
      onSettled,
      onPhaseChange,
    }: {
      isLoading: boolean;
      onSettled: () => void;
      onPhaseChange?: (phase: 'loading' | 'revealing' | 'settled') => void;
    }) {
      const [settled, setSettled] = useState(!isLoading);
      intro.settle = () => setSettled(true);
      useEffect(() => {
        if (!isLoading && !intro.manual) setSettled(true);
      }, [isLoading]);
      const phase = settled ? 'settled' : isLoading ? 'loading' : 'revealing';
      useEffect(() => {
        onPhaseChange?.(phase);
      }, [phase, onPhaseChange]);
      useEffect(() => {
        if (settled) onSettled();
      }, [settled, onSettled]);
      return settled ? null : <div data-testid="hero-reveal" data-loading={String(isLoading)} />;
    },
  };
});

/**
 * The useHomeChrome of the module graph HomeView was imported from. Each test
 * resets modules, and a mock factory runs once, so the stand-in SiteNav reads
 * the hook from here at render time, where it shares HomeView's context.
 */
const chromeHook = vi.hoisted(() => ({ use: null as null | (() => { hold: (reason: string) => void; release: (reason: string) => void }) }));

// A stand-in SiteNav with a menu that holds the chrome open, as a consumer of useHomeChrome would.
vi.mock('@/components/site/SiteNav', () => ({
  default: function SiteNav() {
    const { hold, release } = chromeHook.use!();
    return (
      <nav aria-label="Primary">
        <button type="button" onClick={() => hold('dialog')}>
          Open menu
        </button>
        <button type="button" onClick={() => release('dialog')}>
          Close menu
        </button>
      </nav>
    );
  },
}));

const photo = (n: number, total: number): HomePhoto => ({
  id: `/original-${n}.jpg`,
  accessibleName: `Photograph ${n} of ${total}`,
  sources: { thumbnail: `/thumb-${n}.webp`, full: `/optimized-${n}.webp` },
  width: 1200,
  height: 800,
});

const three = [photo(1, 3), photo(2, 3), photo(3, 3)];

type RenderOptions = { photos?: HomePhoto[]; photosStatus?: HomePhotosStatus; outside?: boolean };

async function renderHome({ photos = three, photosStatus = 'ready', outside = false }: RenderOptions = {}) {
  const { default: HomeView } = await import('../HomeView');
  chromeHook.use = (await import('../useHomeChrome')).useHomeChrome;
  const view = render(
    <StrictMode>
      {outside && <button type="button">Outside</button>}
      <HomeView photos={photos} photosStatus={photosStatus} />
    </StrictMode>,
  );
  const main = () => view.container.querySelector('main')!;
  const playback = () => view.container.querySelector('[data-playback]')?.getAttribute('data-playback');
  const loading = () => main().getAttribute('data-home-loading');
  const slideImage = (slide: number) => view.container.querySelectorAll<HTMLImageElement>('img[data-layer="optimized"]')[slide];
  // The photograph on screen getting its full-quality layer is what ends loading.
  const becomeReady = () =>
    act(() => {
      fireEvent.load(view.container.querySelector('[aria-hidden="false"] > img[data-layer="optimized"]')!);
    });
  return { ...view, main, playback, loading, slideImage, becomeReady };
}

const button = (name: string) => screen.getByRole('button', { name });
const queryButton = (name: string) => screen.queryByRole('button', { name });
const position = () => screen.getByRole('group', { name: 'Slideshow' }).querySelector('span')?.textContent;
const state = () => document.querySelector('main')?.getAttribute('data-interface-state');
const holds = () => document.querySelector('main')?.getAttribute('data-chrome-holds');
const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

let lastX = 0;
/** A real mouse move over Home, which is what reveals the chrome. */
function reveal() {
  lastX += 1;
  act(() => {
    document
      .querySelector('main')!
      .dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', isPrimary: true, clientX: lastX, clientY: 200, movementX: 1, bubbles: true }));
  });
  expect(state()).toBe('interactive');
}

/** The idle and the fade, with a commit between them as in a browser. */
function recede() {
  advance(HOME_CHROME_IDLE_MS);
  advance(HOME_CHROME_FADE_MS);
  expect(state()).toBe('immersive');
}

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
    intro.manual = false;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('loading', () => {
    it('stays loading until the first photograph shows, then starts immersive and advances a full interval later', async () => {
      const { loading, playback, becomeReady, main } = await renderHome();
      expect(loading()).toBe('true');
      expect(main()).toHaveAttribute('data-home-intro', 'loading');
      expect(screen.getByTestId('hero-reveal')).toHaveAttribute('data-loading', 'true');
      expect(playback()).toBe('not-ready');

      advance(5000);
      expect(loading()).toBe('true');
      expect(position()).toBe('01 / 03');

      becomeReady();
      expect(loading()).toBe('false');
      expect(main()).toHaveAttribute('data-home-intro', 'settled');
      expect(state()).toBe('immersive');
      expect(holds()).toBe('');
      expect(playback()).toBe('advancing');
      advance(HOME_AUTO_ADVANCE_MS - 1);
      expect(position()).toBe('01 / 03');
      advance(1);
      expect(position()).toBe('02 / 03');
    });

    it('a return visit skips loading and the intro, and the slideshow waits for the photograph', async () => {
      const first = await renderHome();
      first.becomeReady();
      first.unmount();

      const second = await renderHome();
      expect(second.loading()).toBe('false');
      expect(second.main()).toHaveAttribute('data-home-intro', 'settled');
      expect(screen.queryByTestId('hero-reveal')).toBeNull();
      expect(second.playback()).toBe('not-ready');
      second.becomeReady();
      expect(second.playback()).toBe('advancing');
    });

    for (const photosStatus of ['empty', 'error'] as const) {
      it(`an ${photosStatus} photo list ends loading at once and holds the chrome up`, async () => {
        const { loading, main } = await renderHome({ photos: [], photosStatus });
        expect(loading()).toBe('false');
        expect(holds()).toBe('no-photo');
        expect(state()).toBe('interactive');
        expect(main()).toHaveAttribute('data-home-intro', 'settled');
        advance(HOME_CHROME_IDLE_MS * 3);
        expect(state()).toBe('interactive');
        expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
      });
    }

    it('a failed first image ends loading at once and holds the chrome up', async () => {
      const { loading, slideImage } = await renderHome();
      act(() => {
        fireEvent.error(slideImage(0));
      });
      expect(loading()).toBe('false');
      expect(holds()).toBe('no-photo');
      expect(state()).toBe('interactive');
    });

    it('with the first photograph stalled, one reached with Next releases the no-photo hold for good', async () => {
      const { loading, playback, slideImage, becomeReady } = await renderHome();
      advance(HOME_LOADING_TIMEOUT_MS);
      expect(loading()).toBe('false');
      expect(holds()).toBe('no-photo');
      expect(playback()).toBe('not-ready');

      fireEvent.click(button('Next photograph'));
      expect(position()).toBe('02 / 03');
      becomeReady();
      expect(holds()).toBe('');
      expect(playback()).toBe('advancing');

      // The first slide failing late changes nothing now.
      act(() => {
        fireEvent.error(slideImage(0));
      });
      expect(holds()).toBe('');
    });

    it('a photograph loaded off screen counts once Next brings it on', async () => {
      const { slideImage, playback } = await renderHome();
      act(() => {
        fireEvent.load(slideImage(1));
      });
      expect(holds()).toBe('');
      expect(playback()).toBe('not-ready');
      fireEvent.click(button('Next photograph'));
      expect(playback()).toBe('advancing');
    });

    it('the slideshow waits for the intro to settle, and loading ends without it', async () => {
      intro.manual = true;
      const { loading, playback, becomeReady, main } = await renderHome();
      becomeReady();
      expect(loading()).toBe('false');
      expect(main()).toHaveAttribute('data-home-intro', 'revealing');
      expect(playback()).toBe('not-ready');

      act(() => intro.settle());
      expect(main()).toHaveAttribute('data-home-intro', 'settled');
      expect(playback()).toBe('advancing');
    });

    it('under reduced motion shows the shared loading state instead of the intro until the photograph does', async () => {
      setPrefersReducedMotion(true);
      const { becomeReady } = await renderHome();
      expect(screen.getByRole('status')).toHaveTextContent('Loading');
      becomeReady();
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('with motion, the intro is the loading state, so the shared one never renders', async () => {
      await renderHome();
      expect(screen.queryByRole('status')).toBeNull();
    });
  });

  describe('the chrome', () => {
    it('puts SiteNav in the nav region and the slideshow controls in the sequence region, in that order', async () => {
      const { becomeReady, container } = await renderHome();
      becomeReady();
      const chrome = container.querySelector('[data-home-chrome]')!;
      const nav = screen.getByRole('navigation', { name: 'Primary' });
      const group = screen.getByRole('group', { name: 'Slideshow' });
      expect(chrome.querySelector('[data-chrome-region="nav"]')).toContainElement(nav);
      expect(chrome.querySelector('[data-chrome-region="sequence"]')).toContainElement(group);
      expect(nav.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('puts data-playback on a display: contents wrapper inside main, around the photograph and the chrome', async () => {
      const { main, container } = await renderHome();
      expect(main()).not.toHaveAttribute('data-playback');
      const wrapper = container.querySelector('[data-playback]')!;
      expect(wrapper).toHaveClass('contents');
      expect(main()).toContainElement(wrapper as HTMLElement);
      expect(wrapper).toContainElement(container.querySelector('[data-home-chrome]'));
      expect(wrapper).toContainElement(container.querySelector('[data-home-vignette]'));
      expect(wrapper).toContainElement(container.querySelector('img[data-layer="optimized"]'));
    });

    it('wakes nothing on its own: no synthetic event, and the chrome stays receded until intent', async () => {
      const dispatched = vi.spyOn(window, 'dispatchEvent');
      const { becomeReady } = await renderHome();
      becomeReady();
      advance(HOME_LOADING_TIMEOUT_MS);
      expect(state()).toBe('immersive');
      expect(dispatched).not.toHaveBeenCalled();
    });

    it('a menu holding the chrome open holds the slideshow too, and closing it lets both go', async () => {
      const { playback, becomeReady } = await renderHome();
      becomeReady();
      fireEvent.click(button('Open menu'));
      expect(holds()).toBe('dialog');
      expect(playback()).toBe('held');
      advance(HOME_AUTO_ADVANCE_MS * 2);
      expect(position()).toBe('01 / 03');

      fireEvent.click(button('Close menu'));
      expect(holds()).toBe('');
      expect(playback()).toBe('advancing');
      recede();
    });
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

    reveal();
    expect(playback()).toBe('held');
    expect(button('Pause slideshow')).toBeInTheDocument();
    advance(HOME_AUTO_ADVANCE_MS / 4);
    expect(position()).toBe('01 / 03');

    // Resting between the buttons isn't resting on a control, so the chrome recedes and the hold ends with it.
    recede();
    expect(playback()).toBe('advancing');
    reveal();
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
    expect(holds()).toBe('keyboard-focus');
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

  it('a key press after a mouse focus in the chrome makes it keyboard focus, which holds with no move', async () => {
    const { playback, becomeReady } = await renderHome();
    becomeReady();
    const next = button('Next photograph');

    // A click focuses Next without :focus-visible, which doesn't hold.
    focusVisible(next, false);
    act(() => next.focus());
    expect(playback()).toBe('advancing');

    // The browser shows the ring once a key is pressed, with no new focus event.
    vi.restoreAllMocks();
    focusVisible(next, true);
    fireEvent.keyDown(next, { key: 'Shift' });
    expect(playback()).toBe('held');
    advance(HOME_AUTO_ADVANCE_MS * 2);
    expect(position()).toBe('01 / 03');
  });

  it('in Strict Mode, unmounting leaves no timers and balanced listeners', async () => {
    const counts = { added: 0, removed: 0 };
    const types = ['visibilitychange', 'pageshow', 'keydown', 'keyup', 'pointerup', 'pointercancel'];
    for (const target of [document, window]) {
      const add = target.addEventListener.bind(target);
      const remove = target.removeEventListener.bind(target);
      vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
        if (types.includes(type)) counts.added += 1;
        add(type, listener, options);
      });
      vi.spyOn(target, 'removeEventListener').mockImplementation((type, listener, options) => {
        if (types.includes(type)) counts.removed += 1;
        remove(type, listener, options);
      });
    }
    const { becomeReady, unmount } = await renderHome();
    becomeReady();
    reveal();
    advance(HOME_AUTO_ADVANCE_MS);
    expect(position()).toBe('02 / 03');
    act(() => setPrefersReducedMotion(true));
    act(() => setPrefersReducedMotion(false));
    reveal();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

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
    expect(button('Play slideshow')).toBeInTheDocument();
    second.becomeReady();
    expect(second.playback()).toBe('paused');
    second.unmount();

    // A fresh module graph is what a reload gives.
    vi.resetModules();
    const third = await renderHome();
    third.becomeReady();
    expect(button('Pause slideshow')).toBeInTheDocument();
    expect(third.playback()).toBe('advancing');
  });
});
