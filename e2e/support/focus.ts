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

/** Contract rule 4: an outline of at least 3 px, at full opacity all the way up the tree. */
export async function expectFocusRingVisible(target: Locator): Promise<void> {
    const { outline, faded } = await focusAndMeasure(target);
    const problems: string[] = [];
    if (outline.style === 'none') {
        problems.push('outline-style is none');
    } else {
        if (outline.width < 3) problems.push(`outline is ${outline.width}px wide, under 3px`);
        if (outline.alpha === 0) problems.push('outline color is transparent');
    }
    for (const { label, opacity } of faded) problems.push(`${label} has opacity ${opacity}`);
    expect(problems, `Focus ring on ${target} must be visible`).toEqual([]);
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
 * root scroll paddings. Samples the middle of the ring band.
 */
export async function expectNotObscured(target: Locator, chrome: Locator | readonly Locator[]): Promise<void> {
    const { box, ring, viewport } = await focusAndMeasure(target);
    const covers = await chromeBoxes(target, [chrome].flat());
    const band = (box.left - ring.left) / 2;
    const samples = perimeter({ left: box.left - band, top: box.top - band, right: box.right + band, bottom: box.bottom + band });
    const hiddenBy = ({ x, y }: { x: number; y: number }) => {
        if (x < 0 || x > viewport.width || y < 0 || y > viewport.height) return 'outside the viewport';
        const cover = covers.find((c) => x > c.box.left && x < c.box.right && y > c.box.top && y < c.box.bottom);
        return cover ? `under ${cover.label}` : '';
    };

    const room = viewport.height - viewport.scrollPaddingTop - viewport.scrollPaddingBottom;
    if (box.bottom - box.top <= room) {
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
        const visible = samples.filter((sample) => !hiddenBy(sample)).length;
        expect(
            visible,
            `${target} is taller than the space between the scroll paddings, so chrome may cover part of its focus ring but not hide it entirely`,
        ).toBeGreaterThan(0);
    }
}
