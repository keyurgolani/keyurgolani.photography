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

export interface Measurement {
    /** The border box. */
    box: Box;
    /** The border box grown by outline-offset plus outline-width, where the focus ring paints. */
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

/** Measures one element in a single round trip. */
export function measure(target: Locator): Promise<Measurement> {
    return target.evaluate((element): Measurement => {
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

        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const outlineWidth = style.outlineStyle === 'none' ? 0 : parseFloat(style.outlineWidth) || 0;
        const outlineOffset = parseFloat(style.outlineOffset) || 0;
        const extent = Math.max(0, outlineOffset + outlineWidth);
        const dark = style.getPropertyValue('--focus-ring-dark').trim();

        const faded: Measurement['faded'] = [];
        for (let node: Element | null = element; node; node = node.parentElement) {
            const opacity = parseFloat(getComputedStyle(node).opacity);
            if (opacity < 1) faded.push({ label: label(node), opacity });
        }

        // Overflow on html, or on body while html's is visible, applies to the viewport rather than clipping like a box.
        const root = document.documentElement;
        const rootStyle = getComputedStyle(root);
        const viewportOwner = rootStyle.overflowX === 'visible' && rootStyle.overflowY === 'visible' ? document.body : root;
        const holdsFixed = (s: CSSStyleDeclaration) =>
            s.transform !== 'none' || s.translate !== 'none' || s.rotate !== 'none' || s.scale !== 'none' ||
            s.perspective !== 'none' || s.filter !== 'none' || s.backdropFilter !== 'none' || s.containerType !== 'normal' ||
            /paint|layout|strict|content/.test(s.contain) || /transform|translate|rotate|scale|perspective|filter/.test(s.willChange);

        // Only ancestors on the containing-block chain clip: an absolute element escapes a static
        // ancestor's overflow, and a fixed one escapes every ancestor that doesn't hold fixed descendants.
        const clips: Clip[] = [];
        let position = style.position;
        for (let node = element.parentElement; node; node = node.parentElement) {
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
            transitions: element
                .getAnimations()
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
    });
}
