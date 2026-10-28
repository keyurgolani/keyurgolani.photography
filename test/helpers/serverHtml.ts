import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';

/**
 * `element` rendered as the server renders it, with no `window`, so code that
 * runs only in the server render (ResponsivePhoto's head preload) runs here
 * too. jsdom defines `window` for every test, so renderToString alone would
 * take the client path. The global comes back however the render ends.
 */
export function serverHtml(element: ReactElement): string {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { value: undefined, configurable: true, writable: true });
    try {
        return renderToString(element);
    } finally {
        if (saved) Object.defineProperty(globalThis, 'window', saved);
        else delete (globalThis as { window?: unknown }).window;
    }
}

/** The head preloads in a server render's HTML, as elements. */
export function preloadsIn(html: string): HTMLLinkElement[] {
    const host = document.createElement('div');
    host.innerHTML = html;
    return [...host.querySelectorAll<HTMLLinkElement>('link[rel="preload"][as="image"]')];
}
