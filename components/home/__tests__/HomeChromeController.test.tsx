import { act, render } from '@testing-library/react';
import { Profiler, StrictMode, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mediaListenerCounts, setPrefersReducedMotion } from '@/test/matchMedia';
import { setDocumentVisibility } from '@/test/visibility';
import HomeChromeController, { HomeChrome, HomeVignette } from '../HomeChromeController';
import { HOME_CHROME_FADE_MS, HOME_CHROME_IDLE_MS, HOME_LOADING_TIMEOUT_MS } from '../homeChromeConfig';
import { useHomeChrome, type HomeChromeApi } from '../useHomeChrome';

const IDLE = HOME_CHROME_IDLE_MS;
const FADE = HOME_CHROME_FADE_MS;
/** One animation frame on the fake clock. */
const FRAME = 16;

let api: HomeChromeApi;
let visibilities: string[] = [];

function Probe() {
  const chrome = useHomeChrome();
  api = chrome;
  useEffect(() => {
    visibilities.push(chrome.visibility);
  }, [chrome.visibility]);
  return null;
}

type HomeOptions = { loading?: boolean; onNext?: () => void; onRender?: () => void };

function Home({ loading = false, onNext = () => {}, onRender = () => {} }: HomeOptions) {
  // Profiler's onRender runs once per commit inside it, the controller's included.
  return (
    <StrictMode>
      <Profiler id="home" onRender={onRender}>
        <HomeChromeController initialLoading={loading} initialIntro={loading ? 'loading' : 'settled'} data-testid="home">
          <Probe />
          <div data-testid="photo" />
          <HomeVignette />
          <HomeChrome
            nav={<a href="/gallery">Gallery</a>}
            sequence={
              <button type="button" onClick={onNext}>
                Next
              </button>
            }
          />
        </HomeChromeController>
      </Profiler>
    </StrictMode>
  );
}

/** Settled Home with a photograph on screen, unless `photo` is false or it's loading. */
function renderHome({ photo = true, ...options }: HomeOptions & { photo?: boolean } = {}) {
  const onNext = vi.fn();
  const view = render(<Home onNext={onNext} {...options} />);
  if (photo && !options.loading) act(() => api.reportPhoto('shown'));
  const main = view.container.querySelector('main')!;
  return {
    ...view,
    onNext,
    main,
    photo: view.getByTestId('photo'),
    chrome: view.container.querySelector<HTMLElement>('[data-home-chrome]')!,
    next: view.getByRole('button', { name: 'Next' }),
    link: view.getByRole('link', { name: 'Gallery' }),
  };
}

const main = () => document.querySelector('main')!;
const state = () => main().dataset.interfaceState;
const holds = () => main().dataset.chromeHolds;

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

let lastX = 0;
/** A mouse move that moved, unless the init says otherwise. */
function move(init: PointerEventInit = {}) {
  lastX += 1;
  act(() => {
    main().dispatchEvent(
      new PointerEvent('pointermove', { pointerType: 'mouse', pointerId: 1, isPrimary: true, clientX: lastX, clientY: 300, movementX: 1, bubbles: true, ...init }),
    );
  });
}

function pointer(target: Element, type: string, init: PointerEventInit = {}) {
  const event = new PointerEvent(type, { pointerType: 'touch', pointerId: 7, isPrimary: true, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** A click as a pointer ends it, `detail` 1 with its pointerId, or as assistive technology sends it with `detail` 0. */
function click(target: Element, init: PointerEventInit = { detail: 1, pointerId: 7 }) {
  const event = new PointerEvent('click', { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function key(type: 'keydown' | 'keyup', name: string, target: Element = document.activeElement ?? document.body) {
  const event = new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** A revealed chrome that has gone back to immersive with no hold. */
function recede() {
  // React commits between the two, as a browser does, and that commit arms the fade.
  advance(IDLE);
  advance(FADE);
  expect(state()).toBe('immersive');
}

/** What `:focus-visible` reports for the focused element, as a browser decides it. */
let focusVisible: boolean | 'throws' = true;

describe('HomeChromeController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    visibilities = [];
    focusVisible = true;
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      if (selector !== ':focus-visible') return matches.call(this, selector);
      if (focusVisible === 'throws') throw new SyntaxError(`'${selector}' is not a valid selector`);
      return focusVisible && document.activeElement === this;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders Home as an immersive main with its state and extra data attributes, and the chrome in region order', () => {
    const { main, chrome } = renderHome();
    expect(main).toHaveAttribute('data-interface-state', 'immersive');
    expect(main).toHaveAttribute('data-chrome-holds', '');
    expect(main).toHaveAttribute('data-home-loading', 'false');
    expect(main).toHaveAttribute('data-home-intro', 'settled');
    expect(main).toHaveAttribute('data-testid', 'home');
    expect([...chrome.children].map((region) => region.getAttribute('data-chrome-region'))).toEqual(['nav', 'story', 'sequence']);
    expect(document.querySelector('[data-home-vignette]')).toHaveAttribute('aria-hidden', 'true');
    // Receded controls stay in the document, named and focusable.
    expect(chrome.querySelector('[aria-hidden], [inert]')).toBeNull();
  });

  describe('the pointer', () => {
    it('50 mouse moves render Home once, for the reveal, and the chrome recedes a full idle after the last', () => {
      const onRender = vi.fn();
      renderHome({ onRender });
      onRender.mockClear();

      for (let i = 0; i < 50; i += 1) {
        if (i > 0) advance(10);
        move();
      }
      expect(state()).toBe('interactive');
      expect(onRender).toHaveBeenCalledTimes(1);

      advance(IDLE - 1);
      expect(state()).toBe('interactive');
      advance(1);
      expect(state()).toBe('receding');
      advance(FADE - 1);
      expect(state()).toBe('receding');
      advance(1);
      expect(state()).toBe('immersive');
    });

    it('the API object only changes on a transition', () => {
      renderHome();
      move();
      const shown = api;
      move();
      advance(IDLE - 1);
      expect(api).toBe(shown);
    });

    it('a move with no movement changes nothing, and one at a new position counts', () => {
      renderHome();
      move({ movementX: 0, movementY: 0, clientX: 50, clientY: 50 });
      expect(state()).toBe('immersive');
      move({ movementX: 0, movementY: 0, clientX: 50, clientY: 50 });
      expect(state()).toBe('immersive');
      move({ movementX: 0, movementY: 0, clientX: 51, clientY: 50 });
      expect(state()).toBe('interactive');
    });

    it('a pen move reveals and a touch move does not', () => {
      renderHome();
      move({ pointerType: 'touch' });
      expect(state()).toBe('immersive');
      move({ pointerType: 'pen' });
      expect(state()).toBe('interactive');
    });

    it('a move during the fade brings the chrome back for a full idle', () => {
      renderHome();
      move();
      advance(IDLE);
      expect(state()).toBe('receding');
      move();
      expect(state()).toBe('interactive');
      advance(IDLE - 1);
      expect(state()).toBe('interactive');
    });

    it('a wheel on Home and a scroll inside the chrome reveal it', () => {
      const { main, chrome } = renderHome();
      act(() => {
        main.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40 }));
      });
      expect(state()).toBe('interactive');
      recede();
      act(() => {
        chrome.dispatchEvent(new Event('scroll'));
      });
      expect(state()).toBe('interactive');
    });
  });

  describe('the keyboard', () => {
    it('any key but a lone modifier reveals the chrome', () => {
      renderHome();
      for (const modifier of ['Shift', 'Control', 'Alt', 'Meta']) key('keydown', modifier, document.body);
      expect(state()).toBe('immersive');
      key('keydown', 'ArrowRight', document.body);
      expect(state()).toBe('interactive');
    });

    it('keyboard focus in the chrome holds it up, and focus leaving starts a fresh full idle', () => {
      const { link } = renderHome();
      act(() => link.focus());
      expect(state()).toBe('interactive');
      expect(holds()).toBe('keyboard-focus');
      expect(api.isKeyboardHeld).toBe(true);

      advance(IDLE * 3);
      expect(state()).toBe('interactive');

      act(() => link.blur());
      expect(holds()).toBe('');
      expect(api.isKeyboardHeld).toBe(false);
      advance(IDLE - 1);
      expect(state()).toBe('interactive');
      advance(1);
      advance(FADE);
      expect(state()).toBe('immersive');
    });

    it('focus moving between chrome controls keeps the hold', () => {
      const { link, next } = renderHome();
      act(() => link.focus());
      act(() => next.focus());
      expect(holds()).toBe('keyboard-focus');
    });

    it('pointer focus reveals without holding, so the chrome still recedes', () => {
      focusVisible = false;
      const { next } = renderHome();
      act(() => next.focus());
      expect(state()).toBe('interactive');
      expect(holds()).toBe('');
      recede();
      expect(document.activeElement).toBe(next);
    });

    it('a browser that cannot match :focus-visible counts focus as keyboard focus', () => {
      focusVisible = 'throws';
      const { next } = renderHome();
      act(() => next.focus());
      expect(holds()).toBe('keyboard-focus');
    });

    it('a key re-checks focus, so focus that turns keyboard focus holds', () => {
      focusVisible = false;
      const { next } = renderHome();
      act(() => next.focus());
      expect(holds()).toBe('');
      focusVisible = true;
      key('keydown', 'ArrowDown');
      expect(holds()).toBe('keyboard-focus');
    });

    it('the idle re-checks focus before it recedes the chrome', () => {
      focusVisible = false;
      const { next } = renderHome();
      act(() => next.focus());
      expect(holds()).toBe('');
      focusVisible = true;
      advance(IDLE);
      expect(state()).toBe('interactive');
      expect(holds()).toBe('keyboard-focus');
    });

    for (const name of ['Enter', ' ']) {
      it(`${name === ' ' ? 'Space' : name} on a control left focused by a click reveals without activating it`, () => {
        focusVisible = false;
        const { next, onNext } = renderHome();
        act(() => next.focus());
        recede();

        const press = key('keydown', name, next);
        expect(press.defaultPrevented).toBe(true);
        expect(state()).toBe('interactive');
        // The activation a browser would send anyway is dropped.
        const activation = click(next, { detail: 0 });
        expect(activation.defaultPrevented).toBe(true);
        expect(onNext).not.toHaveBeenCalled();

        key('keyup', name, next);
        advance(FRAME);
        click(next, { detail: 0 });
        expect(onNext).toHaveBeenCalledTimes(1);
      });
    }

    it('Enter on revealed chrome activates as usual', () => {
      focusVisible = false;
      const { next } = renderHome();
      act(() => next.focus());
      const press = key('keydown', 'Enter', next);
      expect(press.defaultPrevented).toBe(false);
    });
  });

  describe('the first gesture', () => {
    it('a tap on immersive Home only reveals, and its click never activates the control now under it', () => {
      const { main, photo, next, onNext } = renderHome();
      const down = pointer(photo, 'pointerdown');
      expect(down.defaultPrevented).toBe(false);
      expect(state()).toBe('interactive');
      expect(main).toHaveAttribute('data-reveal-gesture');

      pointer(photo, 'pointerup');
      expect(main).toHaveAttribute('data-reveal-gesture');
      advance(FRAME);
      expect(main).not.toHaveAttribute('data-reveal-gesture');

      // WebKit can send the click to the control that just appeared under the finger.
      const consumed = click(next);
      expect(consumed.defaultPrevented).toBe(true);
      expect(onNext).not.toHaveBeenCalled();

      // The next, targeted tap goes through.
      pointer(next, 'pointerdown');
      pointer(next, 'pointerup');
      click(next);
      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it('the click guard disarms 500 ms after the gesture ends', () => {
      const { photo, next, onNext } = renderHome();
      pointer(photo, 'pointerdown');
      pointer(photo, 'pointerup');
      advance(499);
      expect(click(next).defaultPrevented).toBe(true);
      recede();

      pointer(photo, 'pointerdown');
      pointer(photo, 'pointerup');
      advance(500);
      click(next);
      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it('the guard only takes the click of the pointer that revealed', () => {
      const { photo, next, onNext } = renderHome();
      pointer(photo, 'pointerdown');
      pointer(photo, 'pointerup');
      click(next, { detail: 1, pointerId: 9 });
      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it('a mouse click on immersive Home reveals the same way', () => {
      const { photo, next, onNext } = renderHome();
      pointer(photo, 'pointerdown', { pointerType: 'mouse', pointerId: 1 });
      pointer(photo, 'pointerup', { pointerType: 'mouse', pointerId: 1 });
      // A mouse click has no pointerId in some browsers.
      const event = new MouseEvent('click', { detail: 1, bubbles: true, cancelable: true });
      act(() => {
        next.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
      expect(onNext).not.toHaveBeenCalled();
    });

    it('pointercancel ends the gesture like pointerup', () => {
      const { main, photo, next, onNext } = renderHome();
      pointer(photo, 'pointerdown');
      pointer(photo, 'pointercancel');
      advance(FRAME);
      expect(main).not.toHaveAttribute('data-reveal-gesture');
      advance(500);
      click(next);
      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it('a second finger neither starts a gesture nor ends the first one', () => {
      const { main, photo } = renderHome();
      pointer(photo, 'pointerdown', { pointerId: 8, isPrimary: false });
      expect(state()).toBe('immersive');
      expect(main).not.toHaveAttribute('data-reveal-gesture');

      pointer(photo, 'pointerdown');
      pointer(photo, 'pointerdown', { pointerId: 8, isPrimary: false });
      pointer(photo, 'pointerup', { pointerId: 8, isPrimary: false });
      advance(FRAME);
      expect(main).toHaveAttribute('data-reveal-gesture');
      pointer(photo, 'pointerup');
      advance(FRAME);
      expect(main).not.toHaveAttribute('data-reveal-gesture');
    });

    it('a tap on revealed or fading chrome is never consumed', () => {
      const { next, onNext } = renderHome();
      move();
      pointer(next, 'pointerdown');
      pointer(next, 'pointerup');
      click(next);
      expect(onNext).toHaveBeenCalledTimes(1);

      advance(IDLE);
      expect(state()).toBe('receding');
      pointer(next, 'pointerdown');
      expect(state()).toBe('interactive');
      pointer(next, 'pointerup');
      click(next);
      expect(onNext).toHaveBeenCalledTimes(2);
    });

    it('a pointerdown dispatched on a receded control comes from a script or assistive technology, and passes unconsumed', () => {
      const { main, next, onNext } = renderHome();
      const down = pointer(next, 'pointerdown');
      expect(down.defaultPrevented).toBe(false);
      expect(state()).toBe('interactive');
      expect(main).not.toHaveAttribute('data-reveal-gesture');
      click(next);
      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it('assistive technology activating a receded control works on the first attempt and reveals the chrome', () => {
      const { next, onNext } = renderHome();
      const activation = click(next, { detail: 0 });
      expect(activation.defaultPrevented).toBe(false);
      expect(onNext).toHaveBeenCalledTimes(1);
      expect(state()).toBe('interactive');
    });
  });

  describe('hover and press', () => {
    it('a mouse resting on a control holds the chrome, moving to another control keeps it, and leaving starts a fresh idle', () => {
      const { next, link, photo } = renderHome();
      move();
      pointer(next, 'pointerover', { pointerType: 'mouse', pointerId: 1 });
      expect(holds()).toBe('hover');
      advance(IDLE * 2);
      expect(state()).toBe('interactive');

      pointer(next, 'pointerout', { pointerType: 'mouse', pointerId: 1, relatedTarget: link });
      expect(holds()).toBe('hover');
      pointer(link, 'pointerout', { pointerType: 'mouse', pointerId: 1, relatedTarget: photo });
      expect(holds()).toBe('');
      advance(IDLE - 1);
      expect(state()).toBe('interactive');
      advance(1);
      expect(state()).toBe('receding');
    });

    it('resting on the photograph or the chrome background does not hold, and neither does touch', () => {
      const { chrome, next } = renderHome();
      move();
      pointer(chrome, 'pointerover', { pointerType: 'mouse', pointerId: 1 });
      pointer(next, 'pointerover', { pointerType: 'touch' });
      expect(holds()).toBe('');
      recede();
    });

    it('a press on a control holds until pointerup, then starts a fresh idle', () => {
      const { next } = renderHome();
      move();
      pointer(next, 'pointerdown');
      expect(holds()).toBe('press');
      advance(IDLE * 2);
      expect(state()).toBe('interactive');
      pointer(next, 'pointerup');
      expect(holds()).toBe('');
      advance(IDLE - 1);
      expect(state()).toBe('interactive');
      advance(1);
      expect(state()).toBe('receding');
    });

    for (const end of ['pointercancel', 'lostpointercapture']) {
      it(`${end} releases the press`, () => {
        const { next } = renderHome();
        move();
        pointer(next, 'pointerdown');
        pointer(next, end);
        expect(holds()).toBe('');
      });
    }

    it('a press outside the controls does not hold', () => {
      const { photo } = renderHome();
      move();
      pointer(photo, 'pointerdown', { pointerType: 'mouse', pointerId: 1 });
      expect(holds()).toBe('');
    });
  });

  describe('a hidden document', () => {
    it('drops hover and press and returns Home to immersive, which stays until the next intent', () => {
      const { next } = renderHome();
      move();
      pointer(next, 'pointerover', { pointerType: 'mouse', pointerId: 1 });
      pointer(next, 'pointerdown', { pointerType: 'mouse', pointerId: 1 });
      expect(holds()).toBe('hover press');

      act(() => setDocumentVisibility('hidden'));
      expect(state()).toBe('immersive');
      expect(holds()).toBe('');
      expect(vi.getTimerCount()).toBe(1);

      act(() => setDocumentVisibility('visible'));
      advance(IDLE * 2);
      expect(state()).toBe('immersive');
    });

    it('a consumer hold such as a dialog keeps the chrome up across it, and its release starts the idle', () => {
      renderHome();
      act(() => api.hold('dialog'));
      expect(state()).toBe('interactive');
      expect(holds()).toBe('dialog');

      act(() => setDocumentVisibility('hidden'));
      act(() => setDocumentVisibility('visible'));
      advance(IDLE * 2);
      expect(state()).toBe('interactive');
      expect(api.holds).toEqual(new Set(['dialog']));

      act(() => api.release('dialog'));
      advance(IDLE - 1);
      expect(state()).toBe('interactive');
      advance(1);
      advance(FADE);
      expect(state()).toBe('immersive');
    });

    it('keyboard focus keeps the chrome up across it', () => {
      const { link } = renderHome();
      act(() => link.focus());
      act(() => setDocumentVisibility('hidden'));
      expect(state()).toBe('interactive');
      expect(holds()).toBe('keyboard-focus');
    });

    it('stops the idle while hidden, so a chrome left up by a hold does not time out in the background', () => {
      renderHome();
      act(() => api.hold('dialog'));
      act(() => setDocumentVisibility('hidden'));
      act(() => api.release('dialog'));
      advance(IDLE * 2);
      expect(state()).toBe('interactive');
      act(() => setDocumentVisibility('visible'));
      recede();
    });
  });

  describe('loading', () => {
    it('a first visit ends loading at 6000 ms with nothing shown, and holds the chrome up until a photograph is', () => {
      renderHome({ loading: true });
      expect(main()).toHaveAttribute('data-home-loading', 'true');
      advance(HOME_LOADING_TIMEOUT_MS - 1);
      expect(main()).toHaveAttribute('data-home-loading', 'true');
      expect(state()).toBe('immersive');

      advance(1);
      expect(main()).toHaveAttribute('data-home-loading', 'false');
      expect(state()).toBe('interactive');
      expect(holds()).toBe('no-photo');
      advance(IDLE * 3);
      expect(state()).toBe('interactive');

      // The photograph arriving releases the hold, and the chrome stays a full idle before it recedes.
      act(() => api.reportPhoto('shown'));
      expect(holds()).toBe('');
      advance(IDLE - 1);
      expect(state()).toBe('interactive');
      advance(1);
      advance(FADE);
      expect(state()).toBe('immersive');
    });

    it('a photograph shown ends loading at once and stays immersive, and the intro settles only on its own report', () => {
      renderHome({ loading: true });
      act(() => api.reportPhoto('shown'));
      expect(main()).toHaveAttribute('data-home-loading', 'false');
      expect(main()).toHaveAttribute('data-home-intro', 'loading');
      expect(state()).toBe('immersive');

      act(() => api.reportIntro('revealing'));
      expect(main()).toHaveAttribute('data-home-intro', 'revealing');
      act(() => api.reportIntro('settled'));
      expect(main()).toHaveAttribute('data-home-intro', 'settled');
      advance(HOME_LOADING_TIMEOUT_MS);
      expect(holds()).toBe('');
      expect(state()).toBe('immersive');
    });

    it('no photograph ends loading at once and holds the chrome up', () => {
      renderHome({ loading: true });
      act(() => api.reportPhoto('none'));
      expect(main()).toHaveAttribute('data-home-loading', 'false');
      expect(state()).toBe('interactive');
      expect(holds()).toBe('no-photo');
      advance(HOME_LOADING_TIMEOUT_MS + IDLE);
      expect(state()).toBe('interactive');
    });

    it('a return visit starts with loading over and still holds the chrome when no photograph arrives', () => {
      renderHome({ photo: false });
      expect(main()).toHaveAttribute('data-home-loading', 'false');
      advance(HOME_LOADING_TIMEOUT_MS);
      expect(holds()).toBe('no-photo');
      expect(state()).toBe('interactive');
    });
  });

  describe('reduced motion', () => {
    it('goes straight from interactive to immersive', () => {
      setPrefersReducedMotion(true);
      renderHome();
      move();
      advance(IDLE);
      expect(state()).toBe('immersive');
      expect(visibilities).not.toContain('receding');
    });

    it('switched on mid-fade ends the fade at once', () => {
      renderHome();
      move();
      advance(IDLE);
      expect(state()).toBe('receding');
      act(() => setPrefersReducedMotion(true));
      expect(state()).toBe('immersive');
    });

    it('switched on mid-session skips the next fade', () => {
      renderHome();
      move();
      act(() => setPrefersReducedMotion(true));
      move();
      advance(IDLE);
      expect(state()).toBe('immersive');
      expect(visibilities).not.toContain('receding');
    });
  });

  it('mounting and unmounting under StrictMode leaves no timer, frame, or listener behind', () => {
    const added: [EventTarget, string, unknown, boolean][] = [];
    const removed: typeof added = [];
    const capture = (options?: boolean | AddEventListenerOptions | EventListenerOptions) => (typeof options === 'boolean' ? options : !!options?.capture);
    const view = render(<div />);
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (this: EventTarget, type, listener, options) {
      added.push([this, type, listener, capture(options)]);
      add.call(this, type, listener, options);
    });
    vi.spyOn(EventTarget.prototype, 'removeEventListener').mockImplementation(function (this: EventTarget, type, listener, options) {
      removed.push([this, type, listener, capture(options)]);
      remove.call(this, type, listener, options);
    });
    const media = { ...mediaListenerCounts };

    view.rerender(<Home />);
    act(() => api.reportPhoto('shown'));
    const photo = view.getByTestId('photo');
    const next = view.getByRole('button', { name: 'Next' });
    move();
    pointer(next, 'pointerover', { pointerType: 'mouse', pointerId: 1 });
    act(() => api.hold('dialog'));
    act(() => api.release('dialog'));
    pointer(next, 'pointerout', { pointerType: 'mouse', pointerId: 1, relatedTarget: photo });
    recede();
    // Leave a gesture's frame, its click guard, the idle, and the loading deadline all pending.
    pointer(photo, 'pointerdown');
    pointer(photo, 'pointerup');
    expect(vi.getTimerCount()).toBe(4);
    expect(added.length).toBeGreaterThan(0);

    view.rerender(<div />);
    expect(vi.getTimerCount()).toBe(0);
    const unmatched = added.filter(([target, type, listener, useCapture]) => {
      const index = removed.findIndex((entry) => entry[0] === target && entry[1] === type && entry[2] === listener && entry[3] === useCapture);
      if (index === -1) return true;
      removed.splice(index, 1);
      return false;
    });
    expect(unmatched.map(([target, type]) => `${(target as Node).nodeName ?? 'window'} ${type}`)).toEqual([]);
    expect(mediaListenerCounts.added - media.added).toBeGreaterThan(0);
    expect(mediaListenerCounts.added - media.added).toBe(mediaListenerCounts.removed - media.removed);
  });
});
