import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';

/**
 * What the curator screens' gate tests read of a form at the submit gate (components/site/submitGateScript.ts): the
 * server HTML's markup, each form's name, and what's disabled, so a test can say every form waits in the server HTML,
 * says it's ready once mounted, and that nothing is disabled for it.
 */

/** The server HTML of `element`, in a detached element the test can query. */
export function serverHtml(element: ReactElement): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = renderToString(element);
    return root;
}

/** A form's name, as a screen reader gives it: its aria-label, or the text its aria-labelledby names, in `root`. */
export function formName(form: Element, root: ParentNode = document): string {
    const label = form.getAttribute('aria-label');
    if (label) return label;
    const by = form.getAttribute('aria-labelledby');
    if (by) {
        const named = by
            .split(/\s+/)
            .map((id) => (root.querySelector(`[id="${id}"]`) ?? form.querySelector(`[id="${id}"]`))?.textContent?.trim() ?? '')
            .join(' ')
            .trim();
        if (named) return named;
    }
    // The Publish screen's forms have no name of their own; the first submit's text says which one it is.
    const submit = form.querySelector('button[type="submit"]');
    return `the form of ${(submit?.textContent ?? '').replace(/\s+/g, ' ').trim()}`;
}

/** Each form under `root`, by its name, with where it is at the gate: `waiting`, `ready`, or null with no gate. */
export function gateMarks(root: ParentNode): [string, string | null][] {
    return [...root.querySelectorAll('form')].map((form) => [formName(form, root), form.getAttribute('data-submit-gate')]);
}

/** Every disabled element under `root`, by its tag, name, value and text, to compare the server HTML with the mounted page. */
export const disabledSet = (root: ParentNode) =>
    [...root.querySelectorAll('[disabled]')].map((el) => `${el.localName}${el.getAttribute('name') ? ` ${el.getAttribute('name')}` : ''}${el.getAttribute('value') ? `=${el.getAttribute('value')}` : ''} ${(el.textContent ?? '').trim().slice(0, 30)}`);

/**
 * Watches `root` for a form's gate mark to change, so a test can say a form the client mounts after the page has
 * hydrated was ready from its first render, with no moment a press would drop. Call `flips()` for what changed.
 */
export function watchGate(root: Node): { flips: () => string[]; stop: () => void } {
    const observer = new MutationObserver(() => undefined);
    const seen: string[] = [];
    const take = () => {
        for (const record of observer.takeRecords()) seen.push(`${formName(record.target as Element, root as ParentNode)}: ${record.oldValue} then ${(record.target as Element).getAttribute('data-submit-gate')}`);
    };
    observer.observe(root, { subtree: true, attributes: true, attributeFilter: ['data-submit-gate'], attributeOldValue: true });
    return {
        flips: () => {
            take();
            return [...seen];
        },
        stop: () => {
            take();
            observer.disconnect();
        },
    };
}
