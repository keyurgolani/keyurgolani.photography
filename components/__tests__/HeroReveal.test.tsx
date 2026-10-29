import { act, render } from '@testing-library/react';
import { Activity, StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AboutPortraitView } from '@/lib/siteConfig/portraitVariants';
import { setPrefersReducedMotion } from '@/test/matchMedia';
import { badgePlace, chromeOverflows, copyTone, coverSource, homeCopyTop, meanLuminance, positionOf, textEnlarged, TONE_PIVOT, toneFor, unionOf, V110_LANE, type Box } from '../badgePlace';
import HeroReveal, { BADGE_LINGER_MS, type HeroRevealPhase } from '../HeroReveal';
import { HOME_LOADING_TIMEOUT_MS } from '../home/homeChromeConfig';

type AnimateOptions = { duration?: number; ease?: unknown; onComplete?: () => void };
type FakeMotionValue = { current: number; set: (value: number) => void };

const framer = vi.hoisted(() => ({
  animate: vi.fn<(value: unknown, to: number, options: AnimateOptions) => { stop: () => void }>(() => ({ stop: vi.fn() })),
  /** Every motion value made, in order, by its initial value. */
  values: [] as { current: number; set: (value: number) => void }[],
  /** The class of every motion.div rendered, so a test can tell the overlay never mounted. */
  rendered: [] as string[],
}));

const picture = vi.hoisted(() => ({ props: [] as { still?: boolean; onUnusable?: () => void }[] }));

vi.mock('../ProfilePicture', () => ({
  default: (props: { still?: boolean; onUnusable?: () => void }) => {
    picture.props.push(props);
    return <div data-testid="profile-picture" data-still={String(!!props.still)} />;
  },
}));

vi.mock('framer-motion', async () => {
  const React = await import('react');
  return {
    motion: {
      div: (props: Record<string, unknown>) => {
        framer.rendered.push(String(props.className ?? ''));
        const domProps = { ...props };
        delete domProps.initial;
        delete domProps.animate;
        delete domProps.transition;
        delete domProps.onAnimationComplete;

        return <div {...domProps}>{props.children as React.ReactNode}</div>;
      },
    },
    // Stable across renders, like the real hooks, so effects don't re-run on every render.
    useMotionValue: (initial: number) => {
      const ref = React.useRef<FakeMotionValue | null>(null);
      if (ref.current === null) {
        const value: FakeMotionValue = { current: initial, set: vi.fn((next: number) => (value.current = next)) };
        framer.values.push(value);
        ref.current = value;
      }
      return ref.current;
    },
    useTransform: (value: FakeMotionValue, transform: (value: number) => string) => transform(value.current),
    animate: framer.animate,
  };
});

/** The minimum ripple time, then the lead before the mask opens. */
const RIPPLES_MS = 2400;
const LEAD_MS = 300;
/** The mask's duration. */
const MASK_MS = 1200;
/** v1.1.0's handoff: the portrait leaves 300 ms after the mask starts, takes 0.8 s, and the intro settles 50 ms after. */
const LAND_DELAY_MS = 300;
const LAND_MS = 800;
const SETTLE_MS = 50;
/** The exit starts by this long after mount, so the intro ends within Home's 6 s loading bound. */
const EXIT_DEADLINE_MS = HOME_LOADING_TIMEOUT_MS - LEAD_MS - MASK_MS;

const PORTRAIT: AboutPortraitView = {
  asset: { width: 1600, height: 2000, variants: {} as AboutPortraitView['asset']['variants'] },
  alt: 'A stand-in portrait',
  focalPoint: { x: 50, y: 32 },
};

/** The landing's ends, on the badge's place from HeroReveal.module.css. */
const AT_CENTER = 'translate(-50%, -50%) translate(calc(0 * var(--badge-dx)), calc(0 * var(--badge-dy))) scale(calc(1 - 0 * (1 - var(--badge-scale))))';
const IN_PLACE = 'translate(-50%, -50%) translate(calc(1 * var(--badge-dx)), calc(1 * var(--badge-dy))) scale(calc(1 - 1 * (1 - var(--badge-scale))))';

function renderReveal(isLoading: boolean, { portrait = null }: { portrait?: AboutPortraitView | null } = {}) {
  const onSettled = vi.fn();
  const phases: HeroRevealPhase[] = [];
  const onPhaseChange = (phase: HeroRevealPhase) => {
    if (phases.at(-1) !== phase) phases.push(phase);
  };
  const tree = (loading: boolean) => (
    <StrictMode>
      <HeroReveal isLoading={loading} onSettled={onSettled} onPhaseChange={onPhaseChange} portrait={portrait} />
    </StrictMode>
  );
  const view = render(tree(isLoading));
  const portraitBox = () => view.container.querySelector<HTMLElement>('[class*="portrait"]');
  const badge = () => view.container.querySelector<HTMLElement>('[data-home-badge]');
  const overlay = () => view.container.querySelector('svg');
  const mask = () => view.container.querySelector<HTMLElement>('[class*="grainOverlay"]')?.style.maskImage ?? null;
  const setLoading = (next: boolean) => view.rerender(tree(next));
  /** The portrait landing in its place, as framer-motion reports it. */
  const finishLanding = () =>
    act(() => {
      landingCall()?.[2].onComplete?.();
    });
  return { ...view, onSettled, phases, portraitBox, badge, overlay, mask, setLoading, finishLanding };
}

/** The landing's animate call: the one on v1.1.0's EASE_OUT curve. */
const landingCall = () => framer.animate.mock.calls.find(([, , options]) => Array.isArray(options.ease));
const maskCall = () => framer.animate.mock.calls.find(([, , options]) => options.ease === 'easeInOut');

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

describe('HeroReveal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    framer.rendered.length = 0;
    framer.values.length = 0;
    picture.props.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a return visit with no portrait renders nothing and reports settled once', () => {
    const { container, onSettled, phases } = renderReveal(false);
    expect(container).toBeEmptyDOMElement();
    expect(phases).toEqual(['settled']);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(framer.animate).not.toHaveBeenCalled();
  });

  it('a return visit puts the badge straight in its place, where it stays for 3 s and then follows the chrome', () => {
    const { overlay, portraitBox, badge, phases, onSettled } = renderReveal(false, { portrait: PORTRAIT });
    expect(overlay()).toBeNull();
    expect(portraitBox()).toBeNull();
    expect(badge()).not.toBeNull();
    expect(badge()!.style.transform).toBe(IN_PLACE);
    expect(badge()).toHaveAttribute('data-landed');
    expect(badge()).toHaveAttribute('data-lingering');
    expect(phases).toEqual(['settled']);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(framer.animate).not.toHaveBeenCalled();

    advance(BADGE_LINGER_MS - 1);
    expect(badge()).toHaveAttribute('data-lingering');
    advance(1);
    expect(badge()).not.toHaveAttribute('data-lingering');
    expect(badge()).toHaveAttribute('data-landed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a return visit paints the badge in place and shown from its first frame, so it never fades in', () => {
    // The first paint, before any effect runs: what the server sends, and what a client navigation first commits.
    const html = renderToString(<HeroReveal isLoading={false} onSettled={() => {}} portrait={PORTRAIT} />);
    const badgeTag = /<div[^>]*data-home-badge[^>]*>/.exec(html)?.[0] ?? '';
    expect(badgeTag).toContain('data-landed');
    expect(badgeTag).toContain('data-lingering');
  });

  it("a first visit loads over the grain with the portrait at the center, which glides to its place on v1.1.0's timings and stays as the badge", () => {
    const { overlay, portraitBox, badge, mask, phases, onSettled, setLoading, finishLanding } = renderReveal(true, { portrait: PORTRAIT });
    expect(overlay()).not.toBeNull();
    const element = portraitBox()!;
    expect(element.style.transform).toBe(AT_CENTER);
    expect(badge()).toBeNull();
    // The hole starts at the portrait's radius, under the portrait.
    expect(mask()).toContain('circle 160px');
    expect(phases).toEqual(['loading']);

    setLoading(false);
    advance(RIPPLES_MS + LEAD_MS - 1);
    expect(phases).toEqual(['loading']);
    advance(1);
    expect(phases).toEqual(['loading', 'revealing']);
    expect(maskCall()?.[1]).toBe(1);
    expect(maskCall()?.[2]).toMatchObject({ duration: 1.2, ease: 'easeInOut' });
    expect(landingCall()).toBeUndefined();
    // The portrait doesn't fade during the handoff.
    expect(portraitBox()).toBe(element);

    advance(LAND_DELAY_MS - 1);
    expect(landingCall()).toBeUndefined();
    advance(1);
    const [value, to, options] = landingCall()!;
    expect(value).toBe(framer.values[1]);
    expect(to).toBe(1);
    expect(options).toMatchObject({ duration: 0.8, ease: [0.22, 1, 0.36, 1] });
    expect(onSettled).not.toHaveBeenCalled();

    advance(LAND_MS);
    finishLanding();
    advance(SETTLE_MS - 1);
    expect(phases).toEqual(['loading', 'revealing']);
    advance(1);
    expect(phases).toEqual(['loading', 'revealing', 'settled']);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(overlay()).toBeNull();
    // The same element, now the badge, in its place.
    expect(badge()).toBe(element);
    expect(element.style.transform).toBe(IN_PLACE);
    expect(element).toHaveAttribute('data-landed');
    expect(element).toHaveAttribute('data-lingering');
    advance(BADGE_LINGER_MS);
    expect(element).not.toHaveAttribute('data-lingering');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the landing settles the intro before the mask would finish, at R + 1150 ms', () => {
    const { phases, setLoading, finishLanding } = renderReveal(true, { portrait: PORTRAIT });
    setLoading(false);
    advance(RIPPLES_MS + LEAD_MS);
    advance(LAND_DELAY_MS + LAND_MS);
    finishLanding();
    advance(SETTLE_MS);
    expect(phases).toEqual(['loading', 'revealing', 'settled']);
    expect(LAND_DELAY_MS + LAND_MS + SETTLE_MS).toBeLessThan(MASK_MS);
    const mask = framer.animate.mock.results[framer.animate.mock.calls.indexOf(maskCall()!)].value as { stop: ReturnType<typeof vi.fn> };
    expect(mask.stop).toHaveBeenCalled();
  });

  it('with no portrait the intro still plays, its hole opening from the center, and leaves nothing once settled', () => {
    const { container, overlay, portraitBox, mask, phases, onSettled, setLoading, finishLanding } = renderReveal(true);
    expect(overlay()).not.toBeNull();
    expect(portraitBox()).toBeNull();
    expect(mask()).toContain('circle 0px');
    setLoading(false);
    advance(RIPPLES_MS + LEAD_MS + LAND_DELAY_MS);
    finishLanding();
    advance(SETTLE_MS);
    expect(phases).toEqual(['loading', 'revealing', 'settled']);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();
    expect(picture.props).toEqual([]);
  });

  it('a portrait that fails to load leaves the intro playing without it, and no badge', () => {
    const { container, portraitBox, mask, phases, setLoading, finishLanding } = renderReveal(true, { portrait: PORTRAIT });
    expect(portraitBox()).not.toBeNull();
    act(() => picture.props.at(-1)!.onUnusable!());
    expect(portraitBox()).toBeNull();
    expect(mask()).toContain('circle 0px');
    setLoading(false);
    advance(RIPPLES_MS + LEAD_MS + LAND_DELAY_MS);
    finishLanding();
    advance(SETTLE_MS);
    expect(phases).toEqual(['loading', 'revealing', 'settled']);
    expect(container).toBeEmptyDOMElement();
  });

  it('the ripples run their minimum time from mount, so a slow load reveals at once', () => {
    const { phases, setLoading } = renderReveal(true);
    advance(EXIT_DEADLINE_MS - 1);
    expect(phases).toEqual(['loading']);
    setLoading(false);
    advance(LEAD_MS);
    expect(phases).toEqual(['loading', 'revealing']);
  });

  it('a load that outlasts the deadline still starts the exit by 4500 ms, so the intro ends by 6000 ms', () => {
    const { overlay, badge, phases, onSettled, setLoading, finishLanding } = renderReveal(true, { portrait: PORTRAIT });
    expect(EXIT_DEADLINE_MS).toBe(4500);
    advance(EXIT_DEADLINE_MS + LEAD_MS - 1);
    expect(phases).toEqual(['loading']);
    advance(1);
    expect(phases).toEqual(['loading', 'revealing']);
    expect(framer.animate).toHaveBeenCalledTimes(1);
    const { duration } = maskCall()![2];
    expect(EXIT_DEADLINE_MS + LEAD_MS + (duration ?? Infinity) * 1000).toBeLessThanOrEqual(HOME_LOADING_TIMEOUT_MS);
    advance(LAND_DELAY_MS);
    expect(EXIT_DEADLINE_MS + LEAD_MS + LAND_DELAY_MS + (landingCall()![2].duration ?? Infinity) * 1000 + SETTLE_MS).toBeLessThanOrEqual(HOME_LOADING_TIMEOUT_MS);

    // The intro is gone at 6000 ms on the clock, even with no word from the landing, and the badge is in place.
    advance(MASK_MS - LAND_DELAY_MS - 1);
    expect(phases).toEqual(['loading', 'revealing']);
    advance(1);
    expect(phases).toEqual(['loading', 'revealing', 'settled']);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(overlay()).toBeNull();
    expect(badge()!.style.transform).toBe(IN_PLACE);
    expect(badge()).toHaveAttribute('data-landed');

    // Loading ending later, or the landing's own end, changes nothing.
    setLoading(false);
    advance(RIPPLES_MS);
    finishLanding();
    advance(SETTLE_MS);
    expect(framer.animate).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('loading that ends first still ends the intro early, and clears the deadline', () => {
    const { phases, setLoading } = renderReveal(true);
    advance(1000);
    setLoading(false);
    advance(RIPPLES_MS - 1000 + LEAD_MS);
    expect(phases).toEqual(['loading', 'revealing']);
    // Only the landing's start, the exit's end and Home's bound are left: no deadline starts a second exit.
    expect(vi.getTimerCount()).toBe(3);
    advance(EXIT_DEADLINE_MS);
    expect(framer.animate).toHaveBeenCalledTimes(2);
    expect(phases).toEqual(['loading', 'revealing', 'settled']);
  });

  // Every way the portrait can go, with the photograph early or never: the intro is over by Home's loading bound.
  const portraitPaths = [
    { path: 'absent at render', portrait: null, after: () => {} },
    // Its URL 404s once the file is gone, or the server fails it: ProfilePicture reports it unusable.
    {
      path: 'removed after render',
      portrait: PORTRAIT,
      after: () => {
        advance(700);
        act(() => picture.props.at(-1)!.onUnusable!());
      },
    },
    { path: 'erroring', portrait: PORTRAIT, after: () => act(() => picture.props.at(-1)!.onUnusable!()) },
    // Still on its way when the intro ends: nothing waits for it.
    { path: 'slow', portrait: PORTRAIT, after: () => {} },
  ];
  for (const { path, portrait, after } of portraitPaths) {
    for (const photo of ['early', 'never'] as const) {
      it(`with the portrait ${path} and the photograph ${photo}, the intro settles within ${HOME_LOADING_TIMEOUT_MS} ms`, () => {
        const mounted = Date.now();
        const { phases, overlay, setLoading } = renderReveal(true, { portrait });
        after();
        if (photo === 'early') setLoading(false);
        advance(HOME_LOADING_TIMEOUT_MS - (Date.now() - mounted));
        expect(phases.at(-1)).toBe('settled');
        expect(overlay()).toBeNull();
      });
    }
  }

  it("keeps Home's bound when React disconnects the intro's effects mid-exit and connects them again, as a hidden Activity does", () => {
    const onPhaseChange = vi.fn();
    const tree = (mode: 'visible' | 'hidden', loading: boolean) => (
      <Activity mode={mode}>
        <HeroReveal isLoading={loading} onSettled={() => {}} onPhaseChange={onPhaseChange} />
      </Activity>
    );
    const view = render(tree('visible', true));
    view.rerender(tree('visible', false));
    // The exit has begun: the ripples are fading, and the mask opens 300 ms on.
    advance(RIPPLES_MS + 100);
    view.rerender(tree('hidden', false));
    view.rerender(tree('visible', false));
    advance(HOME_LOADING_TIMEOUT_MS - RIPPLES_MS - 100);
    expect(onPhaseChange).toHaveBeenLastCalledWith('settled');
    expect(view.container.querySelector('svg')).toBeNull();
  });

  it('under reduce at mount renders no intro, and settles once', () => {
    setPrefersReducedMotion(true);
    const { container, onSettled, phases } = renderReveal(true);

    expect(container).toBeEmptyDOMElement();
    expect(framer.rendered.some((name) => name.includes('grainOverlay'))).toBe(false);
    expect(phases).toEqual(['settled']);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('under reduce the badge waits in its place, hidden, until loading ends, then fades in there, still', () => {
    setPrefersReducedMotion(true);
    const { badge, setLoading } = renderReveal(true, { portrait: PORTRAIT });
    expect(framer.rendered.some((name) => name.includes('grainOverlay'))).toBe(false);
    expect(badge()!.style.transform).toBe(IN_PLACE);
    expect(badge()).not.toHaveAttribute('data-landed');
    expect(badge()).not.toHaveAttribute('data-lingering');
    expect(picture.props.at(-1)!.still).toBe(true);

    setLoading(false);
    expect(badge()).toHaveAttribute('data-landed');
    expect(badge()).toHaveAttribute('data-lingering');
    expect(framer.animate).not.toHaveBeenCalled();
  });

  it('turning reduce off after settling replays nothing', () => {
    setPrefersReducedMotion(true);
    const { container, onSettled, setLoading } = renderReveal(true);

    act(() => setPrefersReducedMotion(false));
    setLoading(false);
    advance((RIPPLES_MS + LEAD_MS) * 2);

    expect(container).toBeEmptyDOMElement();
    expect(framer.animate).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('reduce turning on while loading settles at once and leaves no intro timers', () => {
    const { container, overlay, onSettled, phases, unmount } = renderReveal(true);
    expect(overlay()).not.toBeNull();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    act(() => setPrefersReducedMotion(true));

    expect(container).toBeEmptyDOMElement();
    expect(phases).toEqual(['loading', 'settled']);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reduce turning on mid-handoff stops the mask and the landing, puts the badge in place, and their ends change nothing', () => {
    const { badge, overlay, onSettled, setLoading, finishLanding } = renderReveal(true, { portrait: PORTRAIT });
    setLoading(false);
    advance(RIPPLES_MS + LEAD_MS + LAND_DELAY_MS);
    const [mask, landing] = framer.animate.mock.results.map((result) => result.value as { stop: ReturnType<typeof vi.fn> });

    act(() => setPrefersReducedMotion(true));
    expect(mask.stop).toHaveBeenCalled();
    expect(landing.stop).toHaveBeenCalled();
    expect(overlay()).toBeNull();
    expect(badge()!.style.transform).toBe(IN_PLACE);
    expect(badge()).toHaveAttribute('data-landed');
    expect(onSettled).toHaveBeenCalledTimes(1);

    finishLanding();
    advance(SETTLE_MS);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('unmounting mid-intro leaves no timer, and the landing finishing after unmount settles nothing', () => {
    const first = renderReveal(true, { portrait: PORTRAIT });
    first.setLoading(false);
    advance(RIPPLES_MS);
    first.unmount();
    expect(vi.getTimerCount()).toBe(0);

    const second = renderReveal(true, { portrait: PORTRAIT });
    second.setLoading(false);
    advance(RIPPLES_MS + LEAD_MS + LAND_DELAY_MS);
    const results = framer.animate.mock.results.slice(-2).map((result) => result.value as { stop: ReturnType<typeof vi.fn> });
    second.unmount();
    for (const animation of results) expect(animation.stop).toHaveBeenCalled();
    second.finishLanding();
    expect(second.onSettled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('adds no window listener, so nothing in the intro or the badge watches for activity: the chrome decides when the badge shows', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const view = renderReveal(true, { portrait: PORTRAIT });
    view.setLoading(false);
    advance(RIPPLES_MS + LEAD_MS + LAND_DELAY_MS);
    view.finishLanding();
    advance(SETTLE_MS + BADGE_LINGER_MS);
    view.unmount();
    renderReveal(false, { portrait: PORTRAIT }).unmount();
    expect(add).not.toHaveBeenCalled();
  });
});

describe('badgePlace', () => {
  // The catalog Home's boxes as measured in the browser (photo-home-loader round 2, and #96's review probe from 85rem):
  // the nav, then the series title, statement and link, and from 640 px wide the title's dark panel behind them. From
  // 85rem the copy is capped to yield the badge's lane (CatalogHome.module.css), so the title breaks narrower there.
  // The card is 320 px from 768 px wide, 256 px below.
  const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom });
  const nav = (width: number) => box(0, 0, width, 56);
  /**
   * The title's panel, as CatalogHome.module.css draws it from 640 px wide: from the screen's left edge, 3rem above
   * the title, 6rem right of the longer of the title and statement (its fade included), and 1.5rem below the statement.
   */
  const panel = (title: Box, statement: Box) => box(0, title.top - 48, Math.max(title.right, statement.right) + 96, statement.bottom + 24);
  const story = (title: Box, statement: Box, link: Box, wide: boolean) => (wide ? [title, statement, link, panel(title, statement)] : [title, statement, link]);
  /** The oval's box, ring included, for a place, as the browser paints it. */
  const oval = (view: { width: number; height: number }, card: number, place: ReturnType<typeof badgePlace>) => {
    const { dx, dy, scale } = place ?? { dx: 0, dy: view.height / 2 - 280, scale: 0.85 };
    const cx = view.width / 2 + dx;
    const cy = view.height / 2 + dy;
    const above = card / 2 + 2;
    const below = (card + 4) * (3620 / 3394) - above;
    return box(cx - (scale * (card + 4)) / 2 - 4, cy - scale * above - 4, cx + (scale * (card + 4)) / 2 + 4, cy + scale * below + 4);
  };
  const gap = (a: Box, b: Box) => Math.max(b.left - a.right, a.left - b.right, b.top - a.bottom, a.top - b.bottom);

  const screens = [
    { view: { width: 1440, height: 900 }, card: 320, story: story(box(48, 566, 466, 700), box(48, 712, 466, 736), box(48, 756, 186, 800), true), kind: null },
    { view: { width: 1536, height: 864 }, card: 320, story: story(box(48, 527, 514, 664), box(48, 676, 468, 700), box(48, 720, 186, 764), true), kind: null },
    { view: { width: 1366, height: 768 }, card: 320, story: story(box(45, 439, 429, 568), box(45, 580, 429, 604), box(45, 624, 184, 668), true), kind: null },
    { view: { width: 1280, height: 800 }, card: 320, story: story(box(42, 476, 510, 600), box(42, 612, 462, 636), box(42, 656, 181, 700), true), kind: 'clear' },
    { view: { width: 1024, height: 768 }, card: 320, story: story(box(34, 461, 441, 569), box(34, 581, 441, 604), box(34, 624, 172, 668), true), kind: 'clear' },
    { view: { width: 390, height: 844 }, card: 256, story: story(box(16, 580, 274, 648), box(16, 660, 274, 680), box(16, 700, 155, 744), false), kind: 'clear' },
    { view: { width: 360, height: 740 }, card: 256, story: story(box(16, 476, 274, 544), box(16, 556, 274, 576), box(16, 596, 155, 640), false), kind: 'clear' },
    { view: { width: 844, height: 390 }, card: 320, story: story(box(28, 95, 392, 192), box(28, 204, 392, 226), box(28, 246, 166, 290), true), kind: 'side' },
  ] as const;

  it.each(screens)('keeps 16 px from the nav, the story and its panel at $view.width x $view.height, and moves only where it must', ({ view, card, story, kind }) => {
    const place = badgePlace(view, card, nav(view.width), [...story]);
    expect(place?.kind ?? null).toBe(kind);
    const painted = oval(view, card, place);
    for (const blocker of [nav(view.width), ...story]) expect(gap(painted, blocker)).toBeGreaterThanOrEqual(16 - 0.01);
  });

  // The same screens with a copy the cap doesn't narrow enough, as a long title or one long word would leave it.
  const wide1440 = story(box(48, 566, 553, 700), box(48, 712, 467, 736), box(48, 756, 186, 800), true);
  const wide1366 = story(box(45, 439, 533, 568), box(45, 580, 465, 604), box(45, 624, 184, 668), true);

  it("keeps v1.1.0's exact place where it clears the text and the panel, and otherwise lifts the badge only as far as they need, at 0.85", () => {
    // 1440 x 900: v1.1.0's place clears the title, statement and link, so the text alone leaves it where it is.
    const text = wide1440.slice(0, 3);
    expect(badgePlace({ width: 1440, height: 900 }, 320, nav(1440), [...text])).toBeNull();
    // Its panel reaches under the oval's left side, so the badge lifts until it's 16 px above the panel's top.
    const lifted = badgePlace({ width: 1440, height: 900 }, 320, nav(1440), [...wide1440])!;
    expect(lifted).toMatchObject({ kind: 'clear', dx: 0, scale: 0.85 });
    expect(oval({ width: 1440, height: 900 }, 320, lifted).bottom).toBeCloseTo(566 - 48 - 16, 5);
    // A panel that ends 16 px short of the oval leaves v1.1.0's place alone.
    const short = { ...wide1440[3], right: 1440 / 2 - (0.85 * 324) / 2 - 4 - 16 };
    expect(badgePlace({ width: 1440, height: 900 }, 320, nav(1440), [...text, short])).toBeNull();
    // 1366 x 768: just room above the panel at 0.85, under the nav's 16 px.
    const tight = badgePlace({ width: 1366, height: 768 }, 320, nav(1366), [...wide1366])!;
    expect(tight).toMatchObject({ kind: 'clear', dx: 0, scale: 0.85 });
    expect(oval({ width: 1366, height: 768 }, 320, tight).bottom).toBeCloseTo(439 - 48 - 16, 5);
    expect(oval({ width: 1366, height: 768 }, 320, tight).top).toBeGreaterThanOrEqual(56 + 16 - 0.01);
  });

  it("gives the story a lane that ends its panel exactly 16 px short of v1.1.0's badge on every screen from 85rem", () => {
    // v1.1.0's painted oval at 0.85 on the 320 px card reaches 141.7 px left of the center.
    expect(V110_LANE).toBeCloseTo((0.85 * 324) / 2 + 4 + 16, 9);
    for (const [width, height] of [[1360, 768], [1366, 768], [1440, 900], [1536, 864], [1680, 1050], [1920, 1080], [2560, 1440]]) {
      // CatalogHome.module.css: the copy starts at the gutter and is at most 50vw - lane - 6rem - gutter wide, and the
      // panel reaches 6rem past it. A copy at the cap, two lines tall, as at 1440.
      const gutter = Math.min(Math.max(16, 0.033 * width), 48);
      const right = gutter + (width / 2 - V110_LANE - 96 - gutter);
      const top = height - 334;
      const title = box(gutter, top, right, top + 134);
      const statement = box(gutter, top + 146, right, top + 170);
      const boxes = [title, statement, box(gutter, top + 190, gutter + 138, top + 234), panel(title, statement)];
      expect(badgePlace({ width, height }, 320, nav(width), boxes), `${width} x ${height}`).toBeNull();
      expect(gap(oval({ width, height }, 320, null), boxes[3])).toBeCloseTo(16, 9);
    }
  });

  it('scales down toward 0.6 only when the room above the story is too short for 0.85', () => {
    // 1024 x 640: the title's top at 333, so 245 px between the 16 px clearances, room for about 0.68.
    const story = [box(34, 333, 441, 441), box(34, 453, 441, 476), box(34, 496, 172, 540)];
    const place = badgePlace({ width: 1024, height: 640 }, 320, nav(1024), story)!;
    expect(place.kind).toBe('clear');
    expect(place.scale).toBeLessThan(0.85);
    expect(place.scale).toBeGreaterThanOrEqual(0.6);
    const painted = oval({ width: 1024, height: 640 }, 320, place);
    expect(painted.top).toBeGreaterThanOrEqual(56 + 16 - 0.01);
    expect(painted.bottom).toBeLessThanOrEqual(333 - 16 + 0.01);
    // The largest scale that fits, to the hundredth.
    expect(badgePlace({ width: 1024, height: 640 }, 320, nav(1024), story.map((b) => ({ ...b, top: b.top - 4, bottom: b.bottom - 4 })))!.scale).toBeLessThan(place.scale);
  });

  it("moves down under a nav that v1.1.0's place reaches behind, with no story to clear, as Home before the cutover", () => {
    const place = badgePlace({ width: 844, height: 390 }, 320, nav(844), [])!;
    expect(place.kind).toBe('clear');
    expect(oval({ width: 844, height: 390 }, 320, place).top).toBeGreaterThanOrEqual(72 - 0.01);
    expect(badgePlace({ width: 1280, height: 800 }, 320, nav(1280), [])).toBeNull();
    expect(badgePlace({ width: 412, height: 839 }, 256, nav(412), [])).toBeNull();
  });

  it('leaves the place alone before there is a card to measure', () => {
    expect(badgePlace({ width: 390, height: 844 }, 0, nav(390), [])).toBeNull();
  });
});

describe('homeCopyTop', () => {
  const stage: Box = { left: 0, top: 0, right: 390, bottom: 844 };

  it("gives the copy's top as a percentage of the stage, from its highest box", () => {
    const title: Box = { left: 16, top: 520, right: 300, bottom: 600 };
    const link: Box = { left: 16, top: 700, right: 160, bottom: 744 };
    expect(homeCopyTop(stage, [link, title])).toBe(61.61);
  });

  it('follows a title that grows, as with large text, up the stage', () => {
    const at200: Box = { left: 16, top: 280, right: 374, bottom: 600 };
    expect(homeCopyTop(stage, [at200])).toBe(33.18);
  });

  it("measures from the stage's own top, and stays within 0 and 100", () => {
    expect(homeCopyTop({ ...stage, top: 100, bottom: 944 }, [{ left: 0, top: 620, right: 10, bottom: 640 }])).toBe(61.61);
    expect(homeCopyTop(stage, [{ left: 0, top: -40, right: 10, bottom: 10 }])).toBe(0);
  });

  it("leaves the stylesheet's default with no copy or no stage", () => {
    expect(homeCopyTop(stage, [])).toBeNull();
    expect(homeCopyTop({ ...stage, bottom: 0 }, [{ left: 0, top: 10, right: 10, bottom: 20 }])).toBeNull();
  });
});

describe("Home's root and the text size", () => {
  const home = () => (
    <main data-testid="home">
      <div data-chrome-region="story">
        <h1>Coastline, early</h1>
      </div>
      <HeroReveal isLoading={false} onSettled={() => undefined} />
    </main>
  );

  afterEach(() => {
    document.documentElement.style.removeProperty('font-size');
  });

  it('says so on Home\'s root while the text is enlarged, and stops saying so when Home goes', () => {
    document.documentElement.style.fontSize = '32px';
    const view = render(home());
    const root = view.getByTestId('home');
    expect(root.hasAttribute('data-text-enlarged')).toBe(true);
    view.unmount();
    expect(root.hasAttribute('data-text-enlarged')).toBe(false);
  });

  it('says nothing at default text, so Black keeps its wash', () => {
    document.documentElement.style.fontSize = '16px';
    const view = render(home());
    expect(view.getByTestId('home').hasAttribute('data-text-enlarged')).toBe(false);
  });
});

describe('textEnlarged', () => {
  it('is default text at 16px a rem, and at less', () => {
    expect(textEnlarged(16)).toBe(false);
    expect(textEnlarged(14)).toBe(false);
  });

  it('is enlarged text above it, as at 200%', () => {
    expect(textEnlarged(16.5)).toBe(true);
    expect(textEnlarged(32)).toBe(true);
  });

  it("isn't enlarged when the size can't be read", () => {
    expect(textEnlarged(Number.NaN)).toBe(false);
  });
});

describe('chromeOverflows', () => {
  it('is a chrome taller than its box, past a pixel of rounding', () => {
    expect(chromeOverflows(900, 844)).toBe(true);
    expect(chromeOverflows(845, 844)).toBe(false);
    expect(chromeOverflows(844, 844)).toBe(false);
  });
});

describe('copyTone', () => {
  const pixels = (r: number, g: number, b: number, count = 32 * 18) => Array.from({ length: count * 4 }, (_, i) => [r, g, b, 255][i % 4]);
  const image = (overrides: Partial<HTMLImageElement> = {}) =>
    ({
      complete: true,
      naturalWidth: 1600,
      naturalHeight: 900,
      decode: () => Promise.resolve(),
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 1440, bottom: 810, width: 1440, height: 810 }),
      ...overrides,
    }) as unknown as HTMLImageElement;
  const copy: Box = { left: 40, top: 480, right: 600, bottom: 720 };

  it('is dark over a dark region and light over a light one', async () => {
    expect(await copyTone(image(), copy, { sample: async () => pixels(12, 16, 28) })).toBe('dark');
    expect(await copyTone(image(), copy, { sample: async () => pixels(240, 236, 228) })).toBe('light');
  });

  it("stays light at the tie, where both inks read the same, and turns dark just under it", () => {
    expect(toneFor(TONE_PIVOT)).toBe('light');
    expect(toneFor(TONE_PIVOT - 0.01)).toBe('dark');
    expect(toneFor(TONE_PIVOT + 0.01)).toBe('light');
  });

  it("is light when it can't measure: a tainted canvas, no canvas, an image not in, or no overlap", async () => {
    const tainted = async () => {
      throw new DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError');
    };
    expect(await copyTone(image(), copy, { sample: tainted })).toBe('light');
    expect(await copyTone(image(), copy, { sample: async () => null })).toBe('light');
    expect(await copyTone(image({ complete: false }), copy, { sample: async () => pixels(0, 0, 0) })).toBe('light');
    expect(await copyTone(image({ naturalWidth: 0 }), copy, { sample: async () => pixels(0, 0, 0) })).toBe('light');
    expect(await copyTone(image(), { left: 2000, top: 0, right: 2100, bottom: 10 }, { sample: async () => pixels(0, 0, 0) })).toBe('light');
  });

  it('samples the part of the photograph that paints under the copy, as cover crops it', async () => {
    const sample = vi.fn(async () => pixels(0, 0, 0));
    await copyTone(image(), copy, { sample });
    // 1600 x 900 in 1440 x 810 is a scale of 0.9 with no crop.
    const [, source] = sample.mock.calls[0] as unknown as [HTMLImageElement, { x: number; y: number; width: number; height: number }];
    expect(source.x).toBeCloseTo(44.44, 2);
    expect(source.y).toBeCloseTo(533.33, 2);
    expect(source.width).toBeCloseTo(622.22, 2);
    expect(source.height).toBeCloseTo(266.67, 2);
  });
});

describe('coverSource', () => {
  const shown: Box = { left: 0, top: 0, right: 390, bottom: 844 };

  it("maps a region through cover's crop and object-position", () => {
    // A 1600 x 900 photograph in a 390 x 844 phone: scaled by 844/900, 1500 px wide, cropped 555 px a side at 50%.
    const centre = coverSource({ width: 1600, height: 900 }, shown, { left: 0, top: 422, right: 390, bottom: 844 })!;
    expect(centre.x).toBeCloseTo(592.06, 2);
    expect(centre.y).toBeCloseTo(450, 5);
    expect(centre.width).toBeCloseTo(415.88, 2);
    const left = coverSource({ width: 1600, height: 900 }, shown, { left: 0, top: 0, right: 390, bottom: 844 }, { x: 0, y: 0.5 })!;
    expect(left.x).toBeCloseTo(0, 5);
  });

  it('clips the region to the photograph, and is null where nothing of it paints', () => {
    expect(coverSource({ width: 100, height: 100 }, shown, { left: -50, top: -50, right: 10, bottom: 10 })).not.toBeNull();
    expect(coverSource({ width: 100, height: 100 }, shown, { left: 400, top: 0, right: 500, bottom: 10 })).toBeNull();
    expect(coverSource({ width: 0, height: 100 }, shown, shown)).toBeNull();
  });
});

describe('the tone helpers', () => {
  it('averages luminance over RGBA pixels, and gives none for no pixels', () => {
    expect(meanLuminance([255, 255, 255, 255, 0, 0, 0, 255])).toBeCloseTo(0.5, 5);
    expect(meanLuminance([])).toBeNull();
  });

  it("reads object-position's percentages, and the centre for anything else", () => {
    expect(positionOf('30% 80%')).toEqual({ x: 0.3, y: 0.8 });
    expect(positionOf('center')).toEqual({ x: 0.5, y: 0.5 });
    expect(positionOf('10px 20px')).toEqual({ x: 0.5, y: 0.5 });
  });

  it('unions boxes, and gives none for none', () => {
    expect(unionOf([{ left: 10, top: 20, right: 30, bottom: 40 }, { left: 0, top: 30, right: 20, bottom: 60 }])).toEqual({ left: 0, top: 20, right: 30, bottom: 60 });
    expect(unionOf([])).toBeNull();
  });
});
