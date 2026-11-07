/**
 * e2e/support/hydration.ts's last wait, run in the page by waitForFunction, so it takes nothing from outside itself:
 * every form at the submit gate (components/site/submitGateScript.ts) says it's ready. On an Inbox URL the Inbox comes
 * first: it streams in after the shell, so until a gated form is there or its loading state has gone, there's nothing
 * yet to wait for, and the page isn't ready.
 */
export function pageReady(): boolean {
    const forms = [...document.querySelectorAll('form[data-submit-gate]')];
    if (window.location.pathname.startsWith('/curation/inbox') && forms.length === 0) {
        const loading = [...document.querySelectorAll('[role="status"]')].some((element) => (element.textContent ?? '').includes('Loading the inbox'));
        if (loading) return false;
    }
    return forms.every((form) => form.getAttribute('data-submit-gate') === 'ready');
}

/** How long the parity acts give the Inbox's forms to hydrate before they fail by name. */
export const INBOX_HYDRATION_TIMEOUT = 30_000;

/**
 * Run in the page, so it takes nothing from outside itself: null once every Inbox form is ready at the submit gate and
 * claimed by React (a __reactFiber$ key on it, which React sets as it hydrates the node), or why not, naming the first
 * form that isn't by its label, its id or its place. The base (v1.2.0) has no gate, so there only React's claim counts.
 */
export function inboxFormsUnready(): string | null {
    const named = (form: Element) => {
        const label = form.getAttribute('aria-label');
        if (label) return label;
        if (form.id) return `#${form.id}`;
        const parts: string[] = [];
        for (let el: Element | null = form; el && el.localName !== 'body'; el = el.parentElement) {
            if (el.localName === 'main') {
                parts.unshift('main');
                break;
            }
            const same = el.parentElement ? [...el.parentElement.children].filter((child) => child.localName === el!.localName) : [el];
            parts.unshift(`${el.localName}:nth-of-type(${same.indexOf(el) + 1})`);
        }
        return parts.join('>');
    };
    const waiting = document.querySelector('form[data-submit-gate="waiting"]');
    if (waiting) return `an Inbox form kept waiting: ${named(waiting)}`;
    const unclaimed = [...document.querySelectorAll('main form')].find((form) => !Object.keys(form).some((key) => key.startsWith('__reactFiber$')));
    if (unclaimed) return `an Inbox form was never claimed by React: ${named(unclaimed)}`;
    return null;
}

/** What waitForInboxForms needs of a page: Playwright's, or a stand-in. */
export interface InboxPage {
    evaluate(fn: () => string | null): Promise<string | null>;
}

/**
 * Waits for inboxFormsUnready() to say nothing, polling every `interval` ms, and throws within `timeout` with the last
 * reason it gave, so a form that never hydrates fails by name: never a walk on, never a hang.
 */
export async function waitForInboxForms(page: InboxPage, { timeout, interval = 100 }: { timeout: number; interval?: number }): Promise<void> {
    const deadline = Date.now() + timeout;
    let reason: string | null = 'nothing read yet';
    while (Date.now() < deadline) {
        reason = await page.evaluate(inboxFormsUnready);
        if (reason === null) return;
        await new Promise((done) => setTimeout(done, interval));
    }
    throw new Error(`The Inbox didn't hydrate within ${timeout} ms: ${reason}`);
}
