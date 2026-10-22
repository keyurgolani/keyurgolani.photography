/**
 * Home chrome's state, kept pure so every transition is testable without a
 * DOM. HomeChromeController owns the timers and listeners that feed it.
 */

/** `receding` is the fade out, during which the chrome still takes the pointer. */
export type ChromeVisibility = 'immersive' | 'interactive' | 'receding';

export type PhotoStatus = 'unknown' | 'shown' | 'none';

export type IntroPhase = 'loading' | 'revealing' | 'settled';

/** Keyboard focus inside the chrome, which pointer focus never sets. */
export const KEYBOARD_FOCUS = 'keyboard-focus';
/** A mouse or pen resting on a chrome control. */
export const HOVER = 'hover';
/** Any pointer pressed on a chrome control. */
export const PRESS = 'press';
/** No photograph on screen once loading ends, so navigation has to stay up. */
export const NO_PHOTO = 'no-photo';

/** A hidden document drops these, since the pointer can't be resting or pressing anymore. */
const POINTER_HOLDS = [HOVER, PRESS] as const;

export interface ChromeState {
  visibility: ChromeVisibility;
  /** While any hold stands, the chrome stays up and no idle timer runs. Reasons other than the four above are a consumer's. */
  holds: ReadonlySet<string>;
  loading: boolean;
  photo: PhotoStatus;
  intro: IntroPhase;
}

export type ChromeEvent =
  | { type: 'activity' }
  /** The idle timer fired with no hold. `skipFade` goes straight to immersive, as reduced motion does. */
  | { type: 'idleElapsed'; skipFade: boolean }
  | { type: 'fadeEnded' }
  | { type: 'hold'; reason: string }
  | { type: 'release'; reason: string }
  | { type: 'documentHidden' }
  | { type: 'photoReported'; status: 'shown' | 'none' }
  | { type: 'loadingTimedOut' }
  | { type: 'introReported'; phase: IntroPhase };

export function initialChrome({ loading, intro }: { loading: boolean; intro: IntroPhase }): ChromeState {
  return { visibility: 'immersive', holds: new Set(), loading, photo: 'unknown', intro };
}

const withHold = (holds: ReadonlySet<string>, reason: string) => (holds.has(reason) ? holds : new Set(holds).add(reason));

const withoutHolds = (holds: ReadonlySet<string>, reasons: readonly string[]) => {
  if (!reasons.some((reason) => holds.has(reason))) return holds;
  const next = new Set(holds);
  for (const reason of reasons) next.delete(reason);
  return next;
};

/** Returns `state` itself when nothing changes, so React can skip the render. */
export function reduceChrome(state: ChromeState, event: ChromeEvent): ChromeState {
  switch (event.type) {
    case 'activity':
      return state.visibility === 'interactive' ? state : { ...state, visibility: 'interactive' };

    case 'idleElapsed':
      if (state.visibility !== 'interactive' || state.holds.size > 0) return state;
      return { ...state, visibility: event.skipFade ? 'immersive' : 'receding' };

    case 'fadeEnded':
      return state.visibility === 'receding' ? { ...state, visibility: 'immersive' } : state;

    case 'hold': {
      const holds = withHold(state.holds, event.reason);
      if (holds === state.holds && state.visibility === 'interactive') return state;
      return { ...state, holds, visibility: 'interactive' };
    }

    case 'release': {
      const holds = withoutHolds(state.holds, [event.reason]);
      return holds === state.holds ? state : { ...state, holds };
    }

    case 'documentHidden': {
      const holds = withoutHolds(state.holds, POINTER_HOLDS);
      const visibility = holds.size > 0 ? state.visibility : 'immersive';
      return holds === state.holds && visibility === state.visibility ? state : { ...state, holds, visibility };
    }

    case 'photoReported':
      if (event.status === 'shown') {
        const holds = withoutHolds(state.holds, [NO_PHOTO]);
        if (state.photo === 'shown' && !state.loading && holds === state.holds) return state;
        return { ...state, photo: 'shown', loading: false, holds };
      } else {
        const holds = withHold(state.holds, NO_PHOTO);
        if (state.photo === 'none' && !state.loading && holds === state.holds && state.visibility === 'interactive') return state;
        return { ...state, photo: 'none', loading: false, holds, visibility: 'interactive' };
      }

    case 'loadingTimedOut': {
      if (state.photo === 'shown') return state.loading ? { ...state, loading: false } : state;
      const holds = withHold(state.holds, NO_PHOTO);
      if (!state.loading && holds === state.holds && state.visibility === 'interactive') return state;
      return { ...state, loading: false, holds, visibility: 'interactive' };
    }

    case 'introReported':
      return state.intro === event.phase ? state : { ...state, intro: event.phase };
  }
}
