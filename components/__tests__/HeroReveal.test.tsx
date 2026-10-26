import { act, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AboutPortraitView } from '@/lib/siteConfig/portraitVariants';
import { setPrefersReducedMotion } from '@/test/matchMedia';
import { badgePlace, type Box } from '../badgePlace';
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
    // Only the landing's start and the exit's end are left: no deadline starts a second exit.
    expect(vi.getTimerCount()).toBe(2);
    advance(EXIT_DEADLINE_MS);
    expect(framer.animate).toHaveBeenCalledTimes(2);
    expect(phases).toEqual(['loading', 'revealing', 'settled']);
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
  // The catalog Home's boxes as measured in the browser (photo-home-loader round 2): the nav, then the series title,
  // statement and link. The card is 320 px from 768 px wide, 256 px below.
  const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom });
  const nav = (width: number) => box(0, 0, width, 56);
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
    { view: { width: 1440, height: 900 }, card: 320, story: [box(48, 566, 553, 700), box(48, 712, 467, 736), box(48, 756, 186, 800)], kind: null },
    { view: { width: 1536, height: 864 }, card: 320, story: [box(48, 520, 576, 662), box(48, 674, 470, 698), box(48, 718, 186, 762)], kind: null },
    { view: { width: 1366, height: 768 }, card: 320, story: [box(45, 439, 533, 568), box(45, 580, 465, 604), box(45, 624, 184, 668)], kind: 'clear' },
    { view: { width: 1280, height: 800 }, card: 320, story: [box(42, 476, 510, 600), box(42, 612, 462, 636), box(42, 656, 181, 700)], kind: 'clear' },
    { view: { width: 1024, height: 768 }, card: 320, story: [box(34, 461, 441, 569), box(34, 581, 441, 604), box(34, 624, 172, 668)], kind: 'clear' },
    { view: { width: 390, height: 844 }, card: 256, story: [box(16, 580, 274, 648), box(16, 660, 274, 680), box(16, 700, 155, 744)], kind: 'clear' },
    { view: { width: 360, height: 740 }, card: 256, story: [box(16, 476, 274, 544), box(16, 556, 274, 576), box(16, 596, 155, 640)], kind: 'clear' },
    { view: { width: 844, height: 390 }, card: 320, story: [box(28, 95, 392, 192), box(28, 204, 392, 226), box(28, 246, 166, 290)], kind: 'side' },
  ] as const;

  it.each(screens)('keeps 16 px from the nav and the story at $view.width x $view.height, and moves only where it must', ({ view, card, story, kind }) => {
    const place = badgePlace(view, card, nav(view.width), [...story]);
    expect(place?.kind ?? null).toBe(kind);
    const painted = oval(view, card, place);
    for (const blocker of [nav(view.width), ...story]) expect(gap(painted, blocker)).toBeGreaterThanOrEqual(16 - 0.01);
  });

  it("keeps v1.1.0's exact place at 1440 x 900, and lifts the badge at 1366 x 768 only as far as the title needs, at 0.85", () => {
    expect(badgePlace({ width: 1440, height: 900 }, 320, nav(1440), [...screens[0].story])).toBeNull();
    const lifted = badgePlace({ width: 1366, height: 768 }, 320, nav(1366), [...screens[2].story])!;
    expect(lifted.scale).toBe(0.85);
    expect(lifted.dx).toBe(0);
    // The oval's bottom 16 px above the title's top.
    expect(oval({ width: 1366, height: 768 }, 320, lifted).bottom).toBeCloseTo(439 - 16, 5);
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
