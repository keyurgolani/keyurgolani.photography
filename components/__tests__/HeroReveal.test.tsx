import fs from 'node:fs';
import path from 'node:path';
import { act, render } from '@testing-library/react';
import postcss from 'postcss';
import { Activity, StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AboutPortraitView } from '@/lib/siteConfig/portraitVariants';
import { setPrefersReducedMotion } from '@/test/matchMedia';
import { badgePlace, chromeOverflows, copyAboveDarkWash, copyTone, coverSource, DARK_WASH_STATEMENT_TOP, DARK_WASH_TITLE_TOP, homeCopyTop, luminance, positionOf, regionLevel, textEnlarged, TONE_LIGHT_FLOOR, toneFor, unionOf, V110_LANE, type Box } from '../badgePlace';
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
  const panel = (title: Box, statement: Box) => ({ ...box(0, title.top - 48, Math.max(title.right, statement.right) + 96, statement.bottom + 24), panel: true as const });
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

  // A short phone held upright: the story spans the screen, so there is no room beside it. 320 x 568 in Dark, from
  // CatalogHome.module.css: a two-line title, the statement, then Enter the series with All bodies of work under it
  // (below 360 px), above the slideshow's controls. 164 px between the nav's and the title's 16 px is too short for the
  // badge at 0.6, and beside the story, a quarter of the width right of the center, the oval lies on the title.
  const short = { width: 320, height: 568 };
  const shortStory = (lift = 0) =>
    [box(16, 252, 274, 320), box(16, 332, 266, 352), box(16, 372, 155, 416), box(16, 424, 169, 468)].map((b) => ({ ...b, top: b.top - lift, bottom: b.bottom - lift }));
  /** The painted oval's height at `scale` on the 256 px card, ring included. */
  const ovalHeight = (scale: number) => oval(short, 256, { kind: 'clear', dx: 0, dy: 0, scale }).bottom - oval(short, 256, { kind: 'clear', dx: 0, dy: 0, scale }).top;

  it('on a short phone held upright, shrinks the badge above the story rather than put it on the title', () => {
    const place = badgePlace(short, 256, nav(320), shortStory())!;
    expect(place).toMatchObject({ kind: 'clear', dx: 0 });
    expect(place.scale).toBeLessThan(0.6);
    const painted = oval(short, 256, place);
    for (const blocker of [nav(320), ...shortStory()]) expect(gap(painted, blocker)).toBeGreaterThanOrEqual(16 - 0.01);
    // The largest that fits, to the hundredth: a hundredth more no longer fits between the nav and the title.
    expect(ovalHeight(place.scale)).toBeLessThanOrEqual(252 - 16 - (56 + 16) + 0.01);
    expect(ovalHeight(place.scale + 0.01)).toBeGreaterThan(252 - 16 - (56 + 16));
    // Reduced motion's hint under the controls lifts the copy about 25 px: the badge gets smaller, still clear.
    const lifted = badgePlace(short, 256, nav(320), shortStory(25))!;
    expect(lifted.kind).toBe('clear');
    expect(lifted.scale).toBeLessThan(place.scale);
    for (const blocker of [nav(320), ...shortStory(25)]) expect(gap(oval(short, 256, lifted), blocker)).toBeGreaterThanOrEqual(16 - 0.01);
  });

  /** `from` to `to` in `step`s, both ends included. */
  const range = (from: number, to: number, step: number) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);
  /** The least room the painted oval keeps from the screen's edges. */
  const edgeRoom = (view: { width: number; height: number }, painted: Box) => Math.min(painted.left, painted.top, view.width - painted.right, view.height - painted.bottom);
  /** The sweep's most phones, so it stays a unit test's size: 13,144 now. */
  const SWEEP_LIMIT = 15_000;

  it('never puts the badge on the copy of a phone held upright: it is clear of it, or it is out of sight', () => {
    const phones = [320, 360, 375, 390].flatMap((width) => range(480, 900, 4).flatMap((height) => range(0, 240, 8).map((lift) => ({ width, height, lift }))));
    expect(phones.length).toBeGreaterThan(0);
    expect(phones.length).toBeLessThanOrEqual(SWEEP_LIMIT);
    for (const { width, height, lift } of phones) {
      // The copy sits as low as it does at 320 x 568, lifted by a longer title, larger text or the hint.
      const story = shortStory(568 - height + lift).map((b) => ({ ...b, right: Math.min(b.right, width - 16) }));
      const place = badgePlace({ width, height }, 256, nav(width), story);
      // Out of sight: neither clear above the story nor beside it.
      if (place && place.kind !== 'clear' && place.kind !== 'side') continue;
      const painted = oval({ width, height }, 256, place);
      const where = `${width} x ${height}, lifted ${lift}`;
      for (const blocker of story) expect(gap(painted, blocker), where).toBeGreaterThanOrEqual(16 - 0.01);
      // Beside the story keeps clear of the text alone, as it always has; above it keeps clear of the nav and the edges too.
      if (place?.kind === 'side') continue;
      expect(gap(painted, nav(width)), `${where}: the nav`).toBeGreaterThanOrEqual(16 - 0.01);
      expect(edgeRoom({ width, height }, painted), `${where}: the edges`).toBeGreaterThanOrEqual(16 - 0.01);
    }
  });

  it("stays out of sight only where no badge fits even at 0.4, and lands where the intro took it before", () => {
    // A 0.4 badge needs 119 px between the nav's and the title's 16 px.
    const fits = 252 - 16 - (56 + 16) - Math.ceil(ovalHeight(0.4));
    const smallest = badgePlace(short, 256, nav(320), shortStory(fits))!;
    expect(smallest.kind).toBe('clear');
    expect(smallest.scale).toBeCloseTo(0.4, 9);
    const none = badgePlace(short, 256, nav(320), shortStory(fits + 1))!;
    expect(none).toEqual({ kind: 'none', dx: 320 / 4, dy: -10, scale: 0.6 });
  });

  it('goes beside the story only where that clears it, as on a phone held sideways', () => {
    const sideways = badgePlace({ width: 844, height: 390 }, 320, nav(844), [...screens[7].story])!;
    expect(sideways).toEqual({ kind: 'side', dx: 844 / 4, dy: -10, scale: 0.6 });
    // The same screen with the copy reaching under the oval beside it: that place no longer clears.
    const reaching = [...screens[7].story, box(28, 100, 700, 200)];
    expect(badgePlace({ width: 844, height: 390 }, 320, nav(844), reaching)!.kind).not.toBe('side');
  });

  // Phones held sideways and screens zoomed to 200%, scaled from CI's 844 x 390 boxes: the title's type is 1.5rem +
  // 3.5vw, so its two lines and its width follow the width; the statement's 0.9rem + 0.4vw; the gutter 3.3vw. Where the
  // copy fits the screen it sits 115 px above the bottom, and where it doesn't, as at 360 px tall, the title sits 24 px
  // under the nav. 863 x 360 is Pixel 7 held sideways; 640 x 400 is 1280 x 800 at 200%; 683 x 384, 720 x 450 and 768 x
  // 432 are 1366 x 768, 1440 x 900 and 1536 x 864 at 200%. The card is 320 px from 768 px wide, the panel drawn from 640.
  const sidewaysStage = (width: number, height: number) => {
    const type = Math.min(76, Math.max(38, 24 + 0.035 * width));
    const statementType = Math.min(19, Math.max(16, 14.4 + 0.004 * width));
    const gutter = Math.min(48, Math.max(16, 0.033 * width));
    const right = gutter + (360 * type) / 53.54;
    const linkBottom = Math.max(80 + 1.8 * type + 12 + 1.25 * statementType + 20 + 44, height - 115.41);
    const link = box(gutter, linkBottom - 44, gutter + 138, linkBottom);
    const statement = box(gutter, link.top - 20 - 1.25 * statementType, right, link.top - 20);
    const title = box(gutter, statement.top - 12 - 1.8 * type, right, statement.top - 12);
    return { view: { width, height }, card: width >= 768 ? 320 : 256, story: story(title, statement, link, width >= 640) };
  };
  const SIDEWAYS = [
    [863, 360],
    [640, 360],
    [640, 400],
    [683, 384],
    [720, 450],
    [768, 432],
  ] as const;

  it.each(SIDEWAYS)("keeps today's place beside the story at %i x %i, clear of the title, the statement and the link", (width, height) => {
    const { view, card, story } = sidewaysStage(width, height);
    const place = badgePlace(view, card, nav(width), [...story]);
    expect(place).toEqual({ kind: 'side', dx: width / 4, dy: -10, scale: 0.6 });
    const painted = oval(view, card, place);
    for (const text of story.slice(0, 3)) expect(gap(painted, text)).toBeGreaterThanOrEqual(16 - 0.01);
  });

  it("keeps the place beside the story near the nav and on the panel's fade, as today, and leaves it only where it meets the text", () => {
    // 863 x 360: the oval's top is 12.8 px under the nav, and at 640 x 360 it lies on the panel's fade. Both are today's.
    const pixel = sidewaysStage(863, 360);
    expect(gap(oval(pixel.view, 320, badgePlace(pixel.view, 320, nav(863), [...pixel.story])), nav(863))).toBeCloseTo(12.8, 9);
    const narrow = sidewaysStage(640, 360);
    expect(gap(oval(narrow.view, 256, badgePlace(narrow.view, 256, nav(640), [...narrow.story])), narrow.story[3])).toBeLessThan(0);
    // A nav that reaches into the place, or none at all, leaves it where it is.
    for (const tall of [null, box(0, 0, 863, 120)]) expect(badgePlace(pixel.view, 320, tall, [...pixel.story])).toEqual({ kind: 'side', dx: 863 / 4, dy: -10, scale: 0.6 });
    // A statement that reaches under it: beside the story meets the text, and nothing above the story fits under the
    // panel there, so the badge is out of sight.
    const reaching = [...pixel.story.slice(0, 3), { ...pixel.story[1], right: 863 * 0.75 - 101.2 - 15 }, pixel.story[3]];
    expect(badgePlace(pixel.view, 320, nav(863), reaching)!.kind).toBe('none');
    // On a short phone held upright the place beside the story meets the title, so the badge goes above the story.
    expect(badgePlace(short, 256, nav(320), shortStory())!).toMatchObject({ kind: 'clear', dx: 0 });
  });
});

describe("the badge with no clear place (HeroReveal.module.css)", () => {
  const sheet = postcss.parse(fs.readFileSync(path.join(process.cwd(), 'components/HeroReveal.module.css'), 'utf8'));
  const rules = (selector: string) => {
    const found: Record<string, string> = {};
    sheet.walkRules((rule) => {
      if (rule.parent?.type === 'root' && rule.selectors.includes(selector)) rule.walkDecls((decl) => void (found[decl.prop] = decl.value));
    });
    return found;
  };

  it('stays out of sight at default text, so it never lies on the copy', () => {
    expect(rules("main:not([data-text-enlarged]) .badge[data-badge-place='none']")).toEqual({ visibility: 'hidden' });
  });

  it('with the text enlarged, sits beside the story under the scrim, as beside the story does', () => {
    expect(rules("main[data-text-enlarged] .badge:is([data-badge-place='side'], [data-badge-place='none'])")).toEqual({ 'z-index': '42' });
  });
});

describe("the badge's place once the fonts are in", () => {
  // Pixel 7 held sideways, 863 x 360: before the fonts are in the story has no boxes yet, and v1.1.0's place clears;
  // once they are, the title takes its own face and its boxes, which no ResizeObserver here reports.
  const home = () => (
    <main>
      <nav data-chrome-region="nav" />
      <div data-chrome-region="story">
        <span data-chrome-panel="" />
        <h1>Coastline, early</h1>
        <p>A fixture statement, in plain text.</p>
        <a href="/series/coastline">Enter the series</a>
      </div>
      <HeroReveal isLoading={false} onSettled={() => undefined} portrait={PORTRAIT} />
    </main>
  );
  const at = (left: number, top: number, right: number, bottom: number) => DOMRect.fromRect({ x: left, y: top, width: right - left, height: bottom - top });
  const fontsIn: Record<string, DOMRect> = {
    NAV: at(0, 0, 863, 56),
    SPAN: at(0, 32, 489, 235.9),
    H1: at(28.48, 80, 393, 177.6),
    P: at(28.48, 189.6, 393, 211.9),
    A: at(28.48, 231.9, 166.48, 275.9),
  };
  let loaded = false;
  let fontsReady: () => void = () => undefined;
  const original = { width: window.innerWidth, height: window.innerHeight };

  beforeEach(() => {
    loaded = false;
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 863 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 360 });
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: new Promise<void>((resolve) => (fontsReady = resolve)) } });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(320);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return (loaded && fontsIn[this.tagName]) || at(0, 0, 0, 0);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, 'fonts');
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: original.width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: original.height });
  });

  it('measures the place again once the fonts are in', async () => {
    const view = render(home());
    const badge = () => view.container.querySelector<HTMLElement>('[data-badge-place]')!;
    expect(badge().getAttribute('data-badge-place')).toBe('v1.1.0');
    loaded = true;
    await act(async () => {
      fontsReady();
      await Promise.resolve();
    });
    expect(badge().getAttribute('data-badge-place')).toBe('side');
    expect(badge().style.getPropertyValue('--badge-dx')).toBe(`${863 / 4}px`);
    view.unmount();
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

  it('says nothing at default text, so Dark keeps its wash', () => {
    document.documentElement.style.fontSize = '16px';
    const view = render(home());
    expect(view.getByTestId('home').hasAttribute('data-text-enlarged')).toBe(false);
  });
});

describe("Home's root and the copy's height on the stage", () => {
  // Dark's phone stages from 380 px, as CI measured them over a white photograph: 390 x 664, an iPhone in Safari with
  // its toolbars showing; 380 x 800 with reduced motion and a one-line title; and 390 x 844, Dark parity's phone, at
  // default motion and with reduced motion. The title's and the statement's tops in px down the stage.
  const home = () => (
    <main data-testid="home">
      <div data-home-vignette="" />
      <div data-chrome-region="story">
        <h1>Coastline, early</h1>
        <p>A fixture statement, in plain text.</p>
      </div>
      <HeroReveal isLoading={false} onSettled={() => undefined} />
    </main>
  );
  const stageAt = (height: number, titleTop: number, statementTop: number) =>
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.hasAttribute('data-home-vignette')) return DOMRect.fromRect({ x: 0, y: 0, width: 390, height });
      if (this.tagName === 'H1') return DOMRect.fromRect({ x: 16, y: titleTop, width: 258, height: 34 });
      if (this.tagName === 'P') return DOMRect.fromRect({ x: 16, y: statementTop, width: 258, height: 20 });
      return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
    });
  const copyHigh = (height: number, titleTop: number, statementTop: number) => {
    stageAt(height, titleTop, statementTop);
    const view = render(home());
    const high = view.getByTestId('home').hasAttribute('data-copy-high');
    view.unmount();
    return high;
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("says so on Home's root where the title sits above Dark's fixed wash, and stops saying so when Home goes", () => {
    stageAt(664, 400, 480);
    const view = render(home());
    const root = view.getByTestId('home');
    expect(root.querySelector<HTMLElement>('[data-home-vignette]')!.style.getPropertyValue('--home-copy-top')).toBe('60.24%');
    expect(root.hasAttribute('data-copy-high')).toBe(true);
    view.unmount();
    expect(root.hasAttribute('data-copy-high')).toBe(false);
  });

  it('says so for a one-line title under the title line whose statement sits above the statement line', () => {
    // 380 x 800 with reduced motion: the title's top 68.13% down, the statement's 73.88%.
    expect(copyHigh(800, 545, 591)).toBe(true);
  });

  it("says nothing where the title and the statement both sit under their lines, so Dark keeps today's wash", () => {
    // 390 x 844 at default motion, Pixel 7's kind of stage: 68.72% and 78.20%.
    expect(copyHigh(844, 580, 660)).toBe(false);
    // 390 x 844 with reduced motion, Dark parity's phone: 65.69% and 75.20%, under both lines.
    expect(copyHigh(844, 554.42, 634.7)).toBe(false);
  });
});

describe('copyAboveDarkWash', () => {
  // Dark's fixed phone wash (HomeChrome.module.css): rgb(8 10 9) at 0.92 at the stage's bottom and 0.28 at 66% up it.
  const washAt = (up: number) => 0.92 + ((0.28 - 0.92) * up) / 0.66;
  const ratio = (a: number[], b: number[]) => {
    const [lighter, darker] = [luminance(a[0], a[1], a[2]), luminance(b[0], b[1], b[2])].sort((x, y) => y - x);
    return (lighter + 0.05) / (darker + 0.05);
  };
  // The measure's own reading (e2e's worstTextContrast()): the pixel behind the text is the wash over a white
  // photograph in whole 8-bit channels, as the screenshot gives it, and the ink is what the canvas reads Dark's as:
  // the title #f4f6f5, the statement rgba(244, 246, 245, 0.76), which it reads as (244, 246, 244) at 194/255.
  const behind = (down: number) => {
    const wash = washAt(1 - down / 100);
    return [8, 10, 9].map((channel) => Math.round(255 * (1 - wash) + channel * wash));
  };
  /** The ink's reading over the pixel `down`% down the stage. */
  const reading = (ink: number[], alpha: number) => (down: number) => {
    const pixel = behind(down);
    return ratio(ink.map((channel, i) => channel * alpha + pixel[i] * (1 - alpha)), pixel);
  };
  const title = reading([244, 246, 245], 1);
  const statement = reading([244, 246, 244], 194 / 255);
  /** The highest point, to a thousandth of a percent, from which `ink` reads at least `min` all the way down. */
  const from = (ink: (down: number) => number, min: number) => {
    for (let step = 0; step <= 50_000; step += 1) if (ink(50 + step / 1000) >= min) return 50 + step / 1000;
    return Number.NaN;
  };
  // CI's worst pixel at 390 x 844 with reduced motion: the title's top 65.69% down, 4.577:1, and the statement's
  // 75.20%, 4.615:1. Where the reading gives those is where each line box's top sits: the title's above its box (its
  // leading is 0.9), the statement's below its own (1.25).
  const TITLE_LINE_BOX = from(title, 4.577) - 65.69;
  const STATEMENT_LINE_BOX = from(statement, 4.615) - 75.2;
  /** Where a box's top first holds 4.5:1 under today's wash, from its line box's. */
  const titleHolds = from(title, 4.5) - TITLE_LINE_BOX;
  const statementHolds = from(statement, 4.5) - STATEMENT_LINE_BOX;

  it('finds the line boxes where the measure puts them', () => {
    expect(TITLE_LINE_BOX).toBeLessThan(0);
    expect(STATEMENT_LINE_BOX).toBeGreaterThan(0);
  });

  it("draws the title's line where today's wash holds the title at 4.5:1, 0.4 of a point inside it", () => {
    expect(titleHolds).toBeCloseTo(65.09, 2);
    expect(DARK_WASH_TITLE_TOP).toBe(65.5);
    expect(DARK_WASH_TITLE_TOP - titleHolds).toBeGreaterThanOrEqual(0.4);
  });

  it("draws the statement's line where today's wash holds the statement at 4.5:1, a quarter of a point inside it", () => {
    // The statement holds from 74.50% down, so a line at 74.5 had no margin.
    expect(statementHolds).toBeCloseTo(74.5, 2);
    expect(74.5 - statementHolds).toBeLessThan(0.01);
    expect(DARK_WASH_STATEMENT_TOP).toBe(74.75);
    expect(DARK_WASH_STATEMENT_TOP - statementHolds).toBeGreaterThanOrEqual(0.25);
    // Still under Dark parity's statement at 390 x 844 with reduced motion (75.20%, 75.21% in the gate) and Pixel 7's
    // (about 78.1%), so both keep today's wash.
    expect(DARK_WASH_STATEMENT_TOP).toBeLessThan(75.2);
  });

  it("keeps today's wash at 390 x 844 with reduced motion, where CI read the title at 4.577:1 and the statement at 4.615:1", () => {
    expect(copyAboveDarkWash(65.69, 75.2)).toBe(false);
    expect(title(65.69 + TITLE_LINE_BOX)).toBeGreaterThanOrEqual(4.5);
    expect(statement(75.2 + STATEMENT_LINE_BOX)).toBeGreaterThanOrEqual(4.5);
  });

  it("holds the copy far above 4.5:1 where the wash follows it, as CI read Dark under 380 px after the copy-following wash: 12.954 and 8.504 to 8.595", () => {
    // The wash that follows holds at 0.86 up to the copy's top. The title, at the hold, reads 12.917 here, against
    // CI's 12.954; the statement sits lower, in deeper wash, so it reads more than at the hold: CI's 8.504 to 8.595.
    const hold = [8, 10, 9].map((channel) => Math.round(255 * 0.14 + channel * 0.86));
    expect(Math.abs(ratio([244, 246, 245], hold) - 12.954)).toBeLessThan(0.05);
    expect(ratio([244, 246, 244].map((channel, i) => channel * (194 / 255) + hold[i] * (61 / 255)), hold)).toBeLessThanOrEqual(8.504);
  });

  it('is a title whose top sits above the title line, or a statement whose top sits above the statement line', () => {
    for (const top of [0, 40, 54.98, 60.24, 63.8, 65.49]) expect(copyAboveDarkWash(top, 90), `the title ${top}%`).toBe(true);
    for (const top of [0, 60, 72.29, 73.88, 74.5, 74.74]) expect(copyAboveDarkWash(90, top), `the statement ${top}%`).toBe(true);
    // A one-line title under the title line, its statement above the statement line.
    expect(copyAboveDarkWash(68.13, 73.88)).toBe(true);
    for (const [top, below] of [[65.5, 74.75], [65.69, 75.2], [68.72, 78.2], [80, 90], [100, 100]]) expect(copyAboveDarkWash(top, below), `${top}% and ${below}%`).toBe(false);
  });

  it("isn't, with nothing measured, so Dark keeps its wash", () => {
    expect(copyAboveDarkWash(null, null)).toBe(false);
    expect(copyAboveDarkWash(null, 80)).toBe(false);
    expect(copyAboveDarkWash(70, null)).toBe(false);
    expect(copyAboveDarkWash(null, 70)).toBe(true);
    expect(copyAboveDarkWash(60, null)).toBe(true);
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

  it('is dark over a mid-tone region, where a light scrim would fog the photograph', async () => {
    // A dusk sky: relative luminance about 0.3, under the light floor.
    expect(luminance(150, 150, 150)).toBeLessThan(TONE_LIGHT_FLOOR);
    expect(await copyTone(image(), copy, { sample: async () => pixels(150, 150, 150) })).toBe('dark');
  });

  it('is light only from the light floor up', () => {
    expect(TONE_LIGHT_FLOOR).toBe(0.36);
    expect(toneFor(0.2)).toBe('dark');
    expect(toneFor(0.35)).toBe('dark');
    expect(toneFor(0.36)).toBe('light');
    expect(toneFor(0.5)).toBe('light');
  });

  it("is light, the theme's own, when it can't measure at all: a tainted canvas or no canvas", async () => {
    const tainted = async () => {
      throw new DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError');
    };
    expect(await copyTone(image(), copy, { sample: tainted })).toBe('light');
    expect(await copyTone(image(), copy, { sample: async () => null })).toBe('light');
  });

  it("is nothing when it can't measure now, so the caller keeps its tone: an image not in, mid-swap, or not under the copy", async () => {
    const sample = async () => pixels(0, 0, 0);
    expect(await copyTone(image({ complete: false }), copy, { sample })).toBeNull();
    expect(await copyTone(image({ naturalWidth: 0 }), copy, { sample })).toBeNull();
    expect(await copyTone(image({ decode: () => Promise.reject(new Error('EncodingError')) }), copy, { sample })).toBeNull();
    expect(await copyTone(image(), { left: 2000, top: 0, right: 2100, bottom: 10 }, { sample })).toBeNull();
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
  it("reads a region's level as the darker of its mean and its 25th percentile, and none for no pixels", () => {
    const px = (...levels: number[]) => levels.flatMap((v) => [v, v, v, 255]);
    // Half white, half black: mean 0.5, 25th percentile black.
    expect(regionLevel(px(255, 255, 0, 0))).toBe(0);
    // All white but a dark band of a quarter: the band counts.
    expect(regionLevel(px(255, 255, 255, 255, 255, 255, 0, 0))).toBe(0);
    // A light region with a thin dark line: the mean, slightly under white.
    expect(regionLevel(px(255, 255, 255, 255, 255, 255, 255, 0))).toBeCloseTo(0.875, 5);
    expect(regionLevel([])).toBeNull();
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
