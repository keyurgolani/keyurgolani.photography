// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  HOVER,
  initialChrome,
  KEYBOARD_FOCUS,
  NO_PHOTO,
  PRESS,
  reduceChrome,
  type ChromeEvent,
  type ChromeState,
  type ChromeVisibility,
} from '../homeChrome';

const state = (overrides: Partial<ChromeState> = {}): ChromeState => ({
  ...initialChrome({ loading: false, intro: 'settled' }),
  photo: 'shown',
  ...overrides,
});

const holds = (...reasons: string[]) => new Set(reasons);
const run = (start: ChromeState, ...events: ChromeEvent[]) => events.reduce(reduceChrome, start);

describe('reduceChrome', () => {
  it('starts immersive with no holds, loading only on a first visit', () => {
    expect(initialChrome({ loading: true, intro: 'loading' })).toEqual({
      visibility: 'immersive',
      holds: new Set(),
      loading: true,
      photo: 'unknown',
      intro: 'loading',
    });
    expect(initialChrome({ loading: false, intro: 'settled' })).toMatchObject({ loading: false, intro: 'settled' });
  });

  const visibilityCases: [string, ChromeVisibility, ChromeEvent, ChromeVisibility][] = [
    ['activity reveals immersive chrome', 'immersive', { type: 'activity' }, 'interactive'],
    ['activity brings fading chrome back', 'receding', { type: 'activity' }, 'interactive'],
    ['the idle starts the fade', 'interactive', { type: 'idleElapsed', skipFade: false }, 'receding'],
    ['the idle skips the fade under reduced motion', 'interactive', { type: 'idleElapsed', skipFade: true }, 'immersive'],
    ['the fade ends immersive', 'receding', { type: 'fadeEnded' }, 'immersive'],
    ['a fade end with nothing fading changes nothing', 'interactive', { type: 'fadeEnded' }, 'interactive'],
    ['an idle on immersive chrome changes nothing', 'immersive', { type: 'idleElapsed', skipFade: false }, 'immersive'],
  ];
  for (const [name, from, event, to] of visibilityCases) {
    it(name, () => {
      expect(reduceChrome(state({ visibility: from }), event).visibility).toBe(to);
    });
  }

  it('hands back the same state when nothing changes, so React skips the render', () => {
    const shown = state({ visibility: 'interactive' });
    expect(reduceChrome(shown, { type: 'activity' })).toBe(shown);
    expect(reduceChrome(shown, { type: 'release', reason: HOVER })).toBe(shown);
    expect(reduceChrome(shown, { type: 'photoReported', status: 'shown' })).toBe(shown);
    expect(reduceChrome(shown, { type: 'introReported', phase: 'settled' })).toBe(shown);
    const held = state({ visibility: 'interactive', holds: holds(PRESS) });
    expect(reduceChrome(held, { type: 'hold', reason: PRESS })).toBe(held);
  });

  it('a hold reveals the chrome and stops the idle until every hold is released', () => {
    const held = run(state(), { type: 'hold', reason: KEYBOARD_FOCUS }, { type: 'hold', reason: HOVER });
    expect(held).toMatchObject({ visibility: 'interactive', holds: holds(KEYBOARD_FOCUS, HOVER) });
    expect(reduceChrome(held, { type: 'idleElapsed', skipFade: false })).toBe(held);

    const one = reduceChrome(held, { type: 'release', reason: HOVER });
    expect(one.holds).toEqual(holds(KEYBOARD_FOCUS));
    expect(reduceChrome(one, { type: 'idleElapsed', skipFade: false })).toBe(one);

    const none = reduceChrome(one, { type: 'release', reason: KEYBOARD_FOCUS });
    expect(none).toMatchObject({ visibility: 'interactive', holds: holds() });
    expect(reduceChrome(none, { type: 'idleElapsed', skipFade: false }).visibility).toBe('receding');
  });

  it('a consumer hold, such as an open dialog, holds like the built-in ones', () => {
    const held = reduceChrome(state(), { type: 'hold', reason: 'dialog' });
    expect(held).toMatchObject({ visibility: 'interactive', holds: holds('dialog') });
    expect(reduceChrome(held, { type: 'idleElapsed', skipFade: true })).toBe(held);
  });

  describe('a hidden document', () => {
    it('drops hover and press and returns Home to immersive', () => {
      const next = reduceChrome(state({ visibility: 'interactive', holds: holds(HOVER, PRESS) }), { type: 'documentHidden' });
      expect(next).toMatchObject({ visibility: 'immersive', holds: holds() });
    });

    for (const reason of [KEYBOARD_FOCUS, NO_PHOTO, 'dialog']) {
      it(`keeps the chrome up under a ${reason} hold`, () => {
        const next = reduceChrome(state({ visibility: 'interactive', holds: holds(reason, HOVER) }), { type: 'documentHidden' });
        expect(next).toMatchObject({ visibility: 'interactive', holds: holds(reason) });
      });
    }

    it('changes nothing on immersive Home with no hold', () => {
      const idle = state();
      expect(reduceChrome(idle, { type: 'documentHidden' })).toBe(idle);
    });
  });

  describe('loading and the photograph', () => {
    const loading = () => state({ loading: true, photo: 'unknown', intro: 'loading' });

    it('a photograph shown ends loading with no hold, and the chrome stays immersive', () => {
      expect(reduceChrome(loading(), { type: 'photoReported', status: 'shown' })).toMatchObject({
        loading: false,
        photo: 'shown',
        visibility: 'immersive',
        holds: holds(),
      });
    });

    it('no photograph ends loading and holds the chrome up', () => {
      expect(reduceChrome(loading(), { type: 'photoReported', status: 'none' })).toMatchObject({
        loading: false,
        photo: 'none',
        visibility: 'interactive',
        holds: holds(NO_PHOTO),
      });
    });

    it('the deadline with nothing shown holds the chrome up, and a photograph later releases it', () => {
      const timedOut = reduceChrome(loading(), { type: 'loadingTimedOut' });
      expect(timedOut).toMatchObject({ loading: false, photo: 'unknown', visibility: 'interactive', holds: holds(NO_PHOTO) });
      expect(reduceChrome(timedOut, { type: 'photoReported', status: 'shown' })).toMatchObject({ photo: 'shown', holds: holds() });
    });

    it('the deadline after a photograph changes nothing', () => {
      const shown = reduceChrome(loading(), { type: 'photoReported', status: 'shown' });
      expect(reduceChrome(shown, { type: 'loadingTimedOut' })).toBe(shown);
    });

    it('on a return visit the deadline runs for the photograph alone', () => {
      const returning = state({ loading: false, photo: 'unknown' });
      expect(reduceChrome(returning, { type: 'loadingTimedOut' })).toMatchObject({ loading: false, holds: holds(NO_PHOTO), visibility: 'interactive' });
    });

    it('no photograph after one was shown holds the chrome again, as an emptied library would', () => {
      const shown = reduceChrome(loading(), { type: 'photoReported', status: 'shown' });
      expect(reduceChrome(shown, { type: 'photoReported', status: 'none' })).toMatchObject({ photo: 'none', holds: holds(NO_PHOTO), visibility: 'interactive' });
    });

    it('every order of the first report and the deadline ends in one state', () => {
      const orders: [ChromeEvent, ChromeEvent][] = [
        [{ type: 'photoReported', status: 'shown' }, { type: 'loadingTimedOut' }],
        [{ type: 'loadingTimedOut' }, { type: 'photoReported', status: 'shown' }],
      ];
      const ends = orders.map((events) => run(loading(), ...events));
      for (const end of ends) expect(end).toMatchObject({ loading: false, photo: 'shown', holds: holds() });
      const none = [
        run(loading(), { type: 'photoReported', status: 'none' }, { type: 'loadingTimedOut' }),
        run(loading(), { type: 'loadingTimedOut' }, { type: 'photoReported', status: 'none' }),
      ];
      for (const end of none) expect(end).toMatchObject({ loading: false, photo: 'none', holds: holds(NO_PHOTO), visibility: 'interactive' });
    });

    it('the intro phase follows each report and leaves loading alone', () => {
      const revealing = reduceChrome(loading(), { type: 'introReported', phase: 'revealing' });
      expect(revealing).toMatchObject({ intro: 'revealing', loading: true });
      expect(reduceChrome(revealing, { type: 'introReported', phase: 'settled' }).intro).toBe('settled');
    });
  });
});
