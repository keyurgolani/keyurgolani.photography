import type { Locator } from '@playwright/test';

/** A rectangle in viewport CSS px. */
export interface Box {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface Clip {
    label: string;
    /** The ancestor's padding box, where its overflow clips. */
    box: Box;
    /** Whether it clips horizontally and vertically. */
    x: boolean;
    y: boolean;
}

/** A pseudo-element that draws an element's target and ring, as a stretched link's ::after does (#171, B3). */
export type Pseudo = '::before' | '::after';

export interface PseudoOption {
    /**
     * Measure this pseudo-element of the target instead of the target's own box: its box, outline, band, opacity and
     * transitions, and the overflow ancestors that clip it. It must render and be absolutely or fixed positioned, as a
     * stretched target is. Focus is still the target's own.
     */
    pseudo?: Pseudo;
}

export interface Measurement {
    /** The border box, the pseudo-element's when one is measured. */
    box: Box;
    /** The border box grown by outline-offset plus outline-width, where the focus ring paints. An inset ring paints inside the box, so it's the box. */
    ring: Box;
    outline: { style: string; width: number; offset: number; alpha: number };
    /** The computed box-shadow list. Under focus, its first layer is the focus token's band. */
    boxShadow: string;
    /** --focus-ring-dark as an rgb() or rgba() color, or null when the focus token isn't in scope. */
    bandColor: string | null;
    /** The element and each ancestor with an opacity under 1. */
    faded: { label: string; opacity: number }[];
    /** Properties with a CSS transition running on the element. */
    transitions: string[];
    /** The computed transition-property, transition-duration, and transition-delay lists. */
    transition: { property: string; duration: string; delay: string };
    focused: boolean;
    focusVisible: boolean;
    /** Ancestors whose overflow clips the element, innermost first. */
    clips: Clip[];
    viewport: { width: number; height: number; scrollPaddingTop: number; scrollPaddingBottom: number };
}

/** Measures one element, or its `pseudo`-element, in a single round trip. */
export function measure(target: Locator, { pseudo }: PseudoOption = {}): Promise<Measurement> {
    return target.evaluate((element, which): Measurement => {
        const label = (el: Element) => {
            const name = el.getAttribute('aria-label');
            const classes = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 3) : [];
            return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + classes.map((cls) => `.${cls}`).join('') + (name ? `[aria-label="${name}"]` : '');
        };
        const rgbaOf = (color: string) => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (!context) return [0, 0, 0, 1] as const;
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
            return [r, g, b, a / 255] as const;
        };
        /** The color as getComputedStyle serializes it inside box-shadow. */
        const serialize = (color: string) => {
            const [r, g, b, a] = rgbaOf(color);
            return a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(2))})`;
        };
        const length = (value: string, basis: number) => (value.endsWith('%') ? (parseFloat(value) / 100) * basis : parseFloat(value) || 0);

        const root = document.documentElement;
        const holdsFixed = (s: CSSStyleDeclaration) =>
            s.transform !== 'none' || s.translate !== 'none' || s.rotate !== 'none' || s.scale !== 'none' ||
            s.perspective !== 'none' || s.filter !== 'none' || s.backdropFilter !== 'none' || s.containerType !== 'normal' ||
            /paint|layout|strict|content/.test(s.contain) || /transform|translate|rotate|scale|perspective|filter/.test(s.willChange);

        /**
         * A positioned pseudo-element's border box, in viewport px: its containing block's padding box (the nearest
         * positioned ancestor, the element itself included, or the viewport), less its resolved insets and margins.
         * For a positioned box the insets resolve to used px, so this holds for `inset: 0`, a negative inset, or a
         * width with one inset left auto alike.
         */
        const pseudoBox = (pseudoStyle: CSSStyleDeclaration): Box => {
            const content = pseudoStyle.getPropertyValue('content');
            if (content === 'none' || content === 'normal' || pseudoStyle.display === 'none') throw new Error(`${which} renders nothing on ${label(element)}`);
            const fixed = pseudoStyle.position === 'fixed';
            if (!fixed && pseudoStyle.position !== 'absolute') throw new Error(`${which} on ${label(element)} is ${pseudoStyle.position}, and only a positioned ${which} has a box to measure`);
            // With no positioned ancestor, a fixed box's block is the viewport, and an absolute one's the initial
            // containing block, a viewport-sized box at the document's origin, which scrolls with the page.
            let block: Box = fixed
                ? { left: 0, top: 0, right: root.clientWidth, bottom: root.clientHeight }
                : { left: -scrollX, top: -scrollY, right: root.clientWidth - scrollX, bottom: root.clientHeight - scrollY };
            for (let node: Element | null = element; node && node !== root; node = node.parentElement) {
                const s = getComputedStyle(node);
                if (fixed ? !holdsFixed(s) : s.position === 'static' && !holdsFixed(s)) continue;
                if (s.display === 'inline') throw new Error(`${which}'s containing block on ${label(element)} is an inline ${label(node)}, which this doesn't measure`);
                const r = node.getBoundingClientRect();
                const left = r.left + node.clientLeft;
                const top = r.top + node.clientTop;
                block = { left, top, right: left + node.clientWidth, bottom: top + node.clientHeight };
                break;
            }
            const px = (name: string) => {
                const value = pseudoStyle.getPropertyValue(name);
                if (!/^-?[\d.]+(e-?\d+)?px$/.test(value)) throw new Error(`${which} on ${label(element)} has ${name}: ${value}, not a used length`);
                return parseFloat(value);
            };
            return {
                left: block.left + px('left') + px('margin-left'),
                top: block.top + px('top') + px('margin-top'),
                right: block.right - px('right') - px('margin-right'),
                bottom: block.bottom - px('bottom') - px('margin-bottom'),
            };
        };

        const style = which ? getComputedStyle(element, which) : getComputedStyle(element);
        const rect: Box = which ? pseudoBox(style) : element.getBoundingClientRect();
        const outlineWidth = style.outlineStyle === 'none' ? 0 : parseFloat(style.outlineWidth) || 0;
        const outlineOffset = parseFloat(style.outlineOffset) || 0;
        const extent = Math.max(0, outlineOffset + outlineWidth);
        const dark = style.getPropertyValue('--focus-ring-dark').trim();

        const faded: Measurement['faded'] = [];
        if (which && parseFloat(style.opacity) < 1) faded.push({ label: `${label(element)}${which}`, opacity: parseFloat(style.opacity) });
        for (let node: Element | null = element; node; node = node.parentElement) {
            const opacity = parseFloat(getComputedStyle(node).opacity);
            if (opacity < 1) faded.push({ label: label(node), opacity });
        }

        // Overflow on html, or on body while html's is visible, applies to the viewport rather than clipping like a box.
        const rootStyle = getComputedStyle(root);
        const viewportOwner = rootStyle.overflowX === 'visible' && rootStyle.overflowY === 'visible' ? document.body : root;

        // Only ancestors on the containing-block chain clip: an absolute element escapes a static
        // ancestor's overflow, and a fixed one escapes every ancestor that doesn't hold fixed descendants.
        // A pseudo-element's own parent is its element, so the chain starts there.
        const clips: Clip[] = [];
        let position = style.position;
        for (let node = which ? element : element.parentElement; node; node = node.parentElement) {
            const s = getComputedStyle(node);
            const contains = position === 'fixed' ? holdsFixed(s) : position === 'absolute' ? s.position !== 'static' || holdsFixed(s) : true;
            if (!contains) continue;
            position = s.position;
            if (node === root || node === viewportOwner) continue;
            const x = s.overflowX !== 'visible';
            const y = s.overflowY !== 'visible';
            if (!x && !y) continue;
            const r = node.getBoundingClientRect();
            const left = r.left + node.clientLeft;
            const top = r.top + node.clientTop;
            clips.push({ label: label(node), box: { left, top, right: left + node.clientWidth, bottom: top + node.clientHeight }, x, y });
        }

        return {
            box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
            ring: { left: rect.left - extent, top: rect.top - extent, right: rect.right + extent, bottom: rect.bottom + extent },
            outline: { style: style.outlineStyle, width: outlineWidth, offset: outlineOffset, alpha: rgbaOf(style.outlineColor)[3] },
            boxShadow: style.boxShadow,
            bandColor: dark ? serialize(dark) : null,
            faded,
            // A pseudo-element's animations are the document's, with the element and the pseudo as their target.
            transitions: (which
                ? document.getAnimations().filter((animation) => animation.effect instanceof KeyframeEffect && animation.effect.target === element && animation.effect.pseudoElement === which)
                : element.getAnimations())
                .filter((animation): animation is CSSTransition => animation instanceof CSSTransition && animation.playState === 'running')
                .map((transition) => transition.transitionProperty),
            transition: { property: style.transitionProperty, duration: style.transitionDuration, delay: style.transitionDelay },
            focused: element === document.activeElement,
            focusVisible: element.matches(':focus-visible'),
            clips,
            viewport: {
                width: root.clientWidth,
                height: root.clientHeight,
                scrollPaddingTop: length(rootStyle.scrollPaddingTop, root.clientHeight),
                scrollPaddingBottom: length(rootStyle.scrollPaddingBottom, root.clientHeight),
            },
        };
    }, pseudo ?? null);
}

/** The target's border box, or its `pseudo`-element's, in viewport px. */
export async function boxOf(target: Locator, options: PseudoOption = {}): Promise<Box> {
    return (await measure(target, options)).box;
}
