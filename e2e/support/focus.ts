import { expect, type Locator } from '@playwright/test';
import { waitForHydration } from './hydration';
import { measure, type Box, type Measurement } from './measure';

/** Slack for clientWidth and clientHeight, which round to whole px. */
const SLACK = 0.5;
/** Spacing in CSS px between the ring samples expectNotObscured checks. */
const STEP = 2;

/** Focuses the target unless it already has focus, and measures it once it matches :focus-visible. */
async function focusAndMeasure(target: Locator): Promise<Measurement> {
    await waitForHydration(target.page());
    if (!(await target.evaluate((el) => el === document.activeElement))) {
        await target.focus();
    }
    const measured = await measure(target);
    expect(measured.focused, `${target} should take focus`).toBe(true);
    expect(measured.focusVisible, `${target} should match :focus-visible once focused`).toBe(true);
    return measured;
}

/** Properties whose transition would fade the ring or its element in. `all` covers every one of them. */
const RING_PROPERTY = /^(all|outline(-[a-z]+)?|box-shadow|opacity)$/;

/** A computed time list such as "0.3s, 60s" or "150ms", in seconds. */
const seconds = (list: string) =>
    list.split(',').map((time) => (time.trim().endsWith('ms') ? parseFloat(time) / 1000 : parseFloat(time)) || 0);

/**
 * Ring properties the focused element transitions, from its computed style,
 * with their duration plus delay. This catches a fade even when nothing is
 * mid-transition at the moment it's measured.
 */
function declaredFades({ property, duration, delay }: Measurement['transition']): string[] {
    const durations = seconds(duration);
    const delays = seconds(delay);
    return property.split(',').flatMap((name, index) => {
        const total = durations[index % durations.length] + delays[index % delays.length];
        return RING_PROPERTY.test(name.trim()) && total > 0 ? [`${name.trim()} has a ${Number(total.toFixed(3))}s transition under focus`] : [];
    });
}

/** A spread-only shadow layer as getComputedStyle serializes it: color, 0px 0px 0px, spread, and no inset. */
const BAND = /^(rgba?\([^)]*\)) 0px 0px 0px (\d+(?:\.\d+)?)px(?:,|$)/;

/**
 * The token's band: the first box-shadow layer is --focus-ring-dark, spread
 * at least as far as the outline offset so it fills the gap. A shadow rule
 * that lands after the token, such as a Tailwind dark: or hover: variant,
 * replaces the whole list and drops it.
 */
function bandProblems({ boxShadow, bandColor, outline }: Measurement): string[] {
    if (!bandColor) return ['no --focus-ring-dark is in scope, so the focus token is missing'];
    const band = BAND.exec(boxShadow);
    if (!band) return [`box-shadow is "${boxShadow}", which doesn't start with the token's ${bandColor} band`];
    const [, color, spread] = band;
    const problems: string[] = [];
    if (color !== bandColor) problems.push(`the band is ${color}, not the token's ${bandColor}`);
    if (parseFloat(spread) < outline.offset) problems.push(`the band spreads ${spread}px, short of the ${outline.offset}px outline offset`);
    return problems;
}

/**
 * Contract rule 4: an outline of at least 3 px over the token's dark band, at
 * full opacity all the way up the tree, and no fade. A ring that transitions
 * in reads as its start value, so a running transition fails here, and so
 * does one the computed style declares for the ring or opacity.
 */
export async function expectFocusRingVisible(target: Locator): Promise<void> {
    const measured = await focusAndMeasure(target);
    const { outline, faded, transitions, transition } = measured;
    const problems: string[] = [];
    if (outline.style === 'none') {
        problems.push('outline-style is none');
    } else {
        if (outline.width < 3) problems.push(`outline is ${outline.width}px wide, under 3px`);
        if (outline.alpha === 0) problems.push('outline color is transparent');
    }
    problems.push(...bandProblems(measured));
    for (const { label, opacity } of faded) problems.push(`${label} has opacity ${opacity}`);
    const fading = transitions.filter((property) => RING_PROPERTY.test(property));
    if (fading.length > 0) problems.push(`the ring transitions in (${fading.join(', ')}), so it needs transition: none`);
    problems.push(...declaredFades(transition).map((fade) => `${fade}, so it needs transition: none`));
    expect(problems, `Focus ring on ${target} must be visible`).toEqual([]);
}

/**
 * Contract rule 4's no-fade rule on the way out. Once focus leaves, the ring
 * goes at once. A transition on the outline or the band, such as one from
 * transition-all, keeps the old ring fading while the next control shows
 * its own, so two controls look focused.
 */
export async function expectNoFadeOnBlur(target: Locator): Promise<void> {
    await focusAndMeasure(target);
    const fading = await target.evaluate((el) => {
        (el as HTMLElement).blur();
        return el
            .getAnimations()
            .filter((animation): animation is CSSTransition => animation instanceof CSSTransition && animation.playState === 'running')
            .map((transition) => transition.transitionProperty);
    });
    const ring = fading.filter((property) => /^(outline(-[a-z]+)?|box-shadow)$/.test(property));
    expect(ring, `${target} must drop its focus ring at once on blur, so it can't transition these`).toEqual([]);
}

/** Contract rule 4: no overflow ancestor clips the focus ring. */
export async function expectRingNotClipped(target: Locator): Promise<void> {
    const { ring, clips } = await focusAndMeasure(target);
    const cuts: string[] = [];
    for (const { label, box, x, y } of clips) {
        const sides = [
            x && box.left - ring.left > SLACK ? `${(box.left - ring.left).toFixed(1)}px off the left` : '',
            x && ring.right - box.right > SLACK ? `${(ring.right - box.right).toFixed(1)}px off the right` : '',
            y && box.top - ring.top > SLACK ? `${(box.top - ring.top).toFixed(1)}px off the top` : '',
            y && ring.bottom - box.bottom > SLACK ? `${(ring.bottom - box.bottom).toFixed(1)}px off the bottom` : '',
        ].filter(Boolean);
        if (sides.length > 0) cuts.push(`${label} cuts ${sides.join(', ')}`);
    }
    expect(cuts, `No overflow ancestor may clip the focus ring on ${target}`).toEqual([]);
}

interface Cover {
    label: string;
    box: Box;
}

/** Boxes of the rendered chrome elements, minus any that contain the target, since an ancestor never covers it. */
async function chromeBoxes(target: Locator, chrome: readonly Locator[]): Promise<Cover[]> {
    const handle = await target.elementHandle();
    try {
        const covers: Cover[] = [];
        for (const locator of chrome) {
            expect(await locator.count(), `Chrome ${locator} should match an element`).toBeGreaterThan(0);
            const found = await locator.evaluateAll((elements, focused) => elements
                .filter((el) => !el.contains(focused) && !focused.contains(el))
                .flatMap((el) => {
                    let opacity = 1;
                    for (let node: Element | null = el; node; node = node.parentElement) opacity *= parseFloat(getComputedStyle(node).opacity);
                    const r = el.getBoundingClientRect();
                    if (opacity === 0 || getComputedStyle(el).visibility === 'hidden' || r.width === 0 || r.height === 0) return [];
                    const name = el.getAttribute('aria-label');
                    return [{ label: el.tagName.toLowerCase() + (name ? `[aria-label="${name}"]` : ''), box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }];
                }), handle);
            covers.push(...found);
        }
        return covers;
    } finally {
        await handle.dispose();
    }
}

/** Points every STEP px around a box's edge, corners included. */
function perimeter({ left, top, right, bottom }: Box): { x: number; y: number }[] {
    const points: { x: number; y: number }[] = [];
    const across = Math.max(1, Math.ceil((right - left) / STEP));
    const down = Math.max(1, Math.ceil((bottom - top) / STEP));
    for (let i = 0; i <= across; i++) {
        const x = left + ((right - left) * i) / across;
        points.push({ x, y: top }, { x, y: bottom });
    }
    for (let i = 1; i < down; i++) {
        const y = top + ((bottom - top) * i) / down;
        points.push({ x: left, y }, { x: right, y });
    }
    return points;
}

/**
 * Contract rule 4 and WCAG 2.4.11: fixed chrome never entirely hides the
 * focus ring, and leaves it fully clear when the element fits between the
 * root scroll paddings. Samples the middle of the ring band, and for the
 * fully clear case the ring's outer edge too.
 */
export async function expectNotObscured(target: Locator, chrome: Locator | readonly Locator[]): Promise<void> {
    const { box, ring, viewport } = await focusAndMeasure(target);
    const covers = await chromeBoxes(target, [chrome].flat());
    const band = (box.left - ring.left) / 2;
    const middle = perimeter({ left: box.left - band, top: box.top - band, right: box.right + band, bottom: box.bottom + band });
    const hiddenBy = ({ x, y }: { x: number; y: number }) => {
        if (x < 0 || x > viewport.width || y < 0 || y > viewport.height) return 'outside the viewport';
        const cover = covers.find((c) => x > c.box.left && x < c.box.right && y > c.box.top && y < c.box.bottom);
        return cover ? `under ${cover.label}` : '';
    };

    const room = viewport.height - viewport.scrollPaddingTop - viewport.scrollPaddingBottom;
    if (box.bottom - box.top <= room) {
        const samples = [...middle, ...perimeter(ring)];
        const hidden = new Map<string, number>();
        for (const sample of samples) {
            const reason = hiddenBy(sample);
            if (reason) hidden.set(reason, (hidden.get(reason) ?? 0) + 1);
        }
        expect(
            [...hidden].map(([reason, count]) => `${count} of ${samples.length} ring samples ${reason}`),
            `${target} fits between the scroll paddings, so its focus ring must be fully clear`,
        ).toEqual([]);
    } else {
        const visible = middle.filter((sample) => !hiddenBy(sample)).length;
        expect(
            visible,
            `${target} is taller than the space between the scroll paddings, so chrome may cover part of its focus ring but not hide it entirely`,
        ).toBeGreaterThan(0);
    }
}
