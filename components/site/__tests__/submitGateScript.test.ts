import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SUBMIT_GATE_ATTRIBUTE, SUBMIT_GATE_SCRIPT, SUBMIT_GATE_STATUS_TEXT } from '../submitGateScript';

const root = document.documentElement;
let windowKeys: string[] = [];
let rootAttributes: string[] = [];

beforeAll(() => {
    windowKeys = Object.keys(window).sort();
    rootAttributes = root.getAttributeNames().sort();
    // The inline script, run once against the test document, as the page runs it once in <head>.
    new Function(SUBMIT_GATE_SCRIPT)();
});

afterEach(() => {
    document.body.innerHTML = '';
});

/** A form with every kind of control, opted in or not, and a checkbox outside it that belongs to it by `form`. */
function build(gate: 'waiting' | 'ready' | null) {
    document.body.innerHTML = `
        <form id="gated" method="post"${gate === null ? '' : ` ${SUBMIT_GATE_ATTRIBUTE}="${gate}"`}>
            <input id="text" name="reason">
            <textarea id="area" name="description"></textarea>
            <select id="select" name="series"><option value="a">A</option><option value="b">B</option></select>
            <input id="box" type="checkbox" name="decorative">
            <input id="radio" type="radio" name="slot" value="start">
            <button id="send" type="submit" name="intent" value="defer">Decide later</button>
        </form>
        <input id="row" type="checkbox" name="items" form="gated">`;
    const form = document.getElementById('gated') as HTMLFormElement;
    // The form's own handler, as React's would be: it sees the submit only if the gate let it through, and records
    // whether anything had cancelled it first. It then cancels it itself, since jsdom can't navigate.
    const arrivedCancelled: boolean[] = [];
    const reached = vi.fn((event: Event) => {
        arrivedCancelled.push(event.defaultPrevented);
        event.preventDefault();
    });
    form.addEventListener('submit', reached);
    const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    return { form, reached, arrivedCancelled, el };
}

const cancelled = (target: EventTarget, event: Event) => !target.dispatchEvent(event);
const keydown = (key: string) => new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
const beforeinput = () => new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', bubbles: true, cancelable: true });
const mousedown = () => new MouseEvent('mousedown', { bubbles: true, cancelable: true });

describe('SUBMIT_GATE_SCRIPT, while an opted-in form waits for its page to hydrate', () => {
    it('drops a submit by a button press, by requestSubmit, and by Enter, before the form or anything above it sees it', () => {
        const { form, reached, el } = build('waiting');
        el<HTMLButtonElement>('send').click();
        form.requestSubmit();
        form.requestSubmit(el<HTMLButtonElement>('send'));
        // Enter in a field is the browser's implicit submission, a submit event at the form, which jsdom doesn't make
        // from a key press: the browser test presses Enter in Archive's reason.
        expect(cancelled(form, new SubmitEvent('submit', { bubbles: true, cancelable: true }))).toBe(true);
        expect(reached).not.toHaveBeenCalled();
    });

    it('leaves a checkbox, a radio and a checkbox that belongs to it by `form` as they were', () => {
        const { el } = build('waiting');
        for (const id of ['box', 'radio', 'row']) {
            el<HTMLInputElement>(id).click();
            expect(el<HTMLInputElement>(id).checked, id).toBe(false);
        }
    });

    it('takes no typing in a field or text area, and no key or press that would change a select, but lets Tab move on', () => {
        const { el } = build('waiting');
        expect(cancelled(el('text'), beforeinput())).toBe(true);
        expect(cancelled(el('area'), beforeinput())).toBe(true);
        expect(cancelled(el('select'), keydown('ArrowDown'))).toBe(true);
        expect(cancelled(el('select'), keydown('b'))).toBe(true);
        expect(cancelled(el('select'), mousedown())).toBe(true);
        expect(cancelled(el('select'), keydown('Tab'))).toBe(false);
        // Keys in a text field aren't its business: typing is beforeinput's, and Enter is the submit's.
        expect(cancelled(el('text'), keydown('Enter'))).toBe(false);
    });

    it("stops at once when the form is marked ready, and every path works as the browser's own", () => {
        const { form, reached, arrivedCancelled, el } = build('waiting');
        form.setAttribute(SUBMIT_GATE_ATTRIBUTE, 'ready');
        el<HTMLButtonElement>('send').click();
        form.requestSubmit();
        expect(reached).toHaveBeenCalledTimes(2);
        expect(arrivedCancelled).toEqual([false, false]);
        for (const id of ['box', 'radio', 'row']) {
            el<HTMLInputElement>(id).click();
            expect(el<HTMLInputElement>(id).checked, id).toBe(true);
        }
        expect(cancelled(el('text'), beforeinput())).toBe(false);
        expect(cancelled(el('select'), keydown('ArrowDown'))).toBe(false);
        expect(cancelled(el('select'), mousedown())).toBe(false);
    });
});

describe('SUBMIT_GATE_SCRIPT, when the shell has hydrated but the form has not', () => {
    it('still drops every path: html[data-hydrated] is the shell, never the form', () => {
        root.setAttribute('data-hydrated', 'true');
        try {
            const { form, reached, el } = build('waiting');
            el<HTMLButtonElement>('send').click();
            form.requestSubmit();
            expect(cancelled(form, new SubmitEvent('submit', { bubbles: true, cancelable: true }))).toBe(true);
            expect(reached).not.toHaveBeenCalled();
            for (const id of ['box', 'radio', 'row']) {
                el<HTMLInputElement>(id).click();
                expect(el<HTMLInputElement>(id).checked, id).toBe(false);
            }
            expect(cancelled(el('text'), beforeinput())).toBe(true);
            expect(cancelled(el('select'), keydown('ArrowDown'))).toBe(true);
            expect(cancelled(el('select'), mousedown())).toBe(true);
        } finally {
            root.removeAttribute('data-hydrated');
        }
    });
});

/** The status the script shows when it drops something, if any. */
const status = () => document.querySelector<HTMLElement>('[data-submit-gate-status]');
const settle = (ms = 150) => new Promise((done) => setTimeout(done, ms));

describe('SUBMIT_GATE_SCRIPT, the word after a drop', () => {
    it('shows and announces that the page is still loading when it drops a press, and marks the form', async () => {
        const { form, el } = build('waiting');
        el<HTMLButtonElement>('send').click();
        const shown = status();
        expect(shown, 'a status, there before its words so they are read out').not.toBeNull();
        expect(shown).toHaveAttribute('role', 'status');
        expect(shown?.parentElement).toBe(document.body);
        await settle();
        expect(shown).toHaveTextContent(SUBMIT_GATE_STATUS_TEXT);
        expect(SUBMIT_GATE_STATUS_TEXT).toBe('Still loading. Try again in a moment.');
        expect(form).toHaveAttribute('data-submit-dropped', 'true');
        // One status, however many presses.
        form.requestSubmit();
        await settle();
        expect(document.querySelectorAll('[data-submit-gate-status]')).toHaveLength(1);
    });

    it('says it for dropped typing too, and shows nothing while nothing is dropped', async () => {
        const { form, el } = build('waiting');
        await settle();
        expect(status(), 'nothing pressed').toBeNull();
        el('text').dispatchEvent(beforeinput());
        await settle();
        expect(status()).toHaveTextContent(SUBMIT_GATE_STATUS_TEXT);
        expect(form).toHaveAttribute('data-submit-dropped', 'true');
    });

    it('shows nothing for a form without the attribute, or one that is ready', async () => {
        for (const gate of [null, 'ready'] as const) {
            const { form, el } = build(gate);
            el<HTMLButtonElement>('send').click();
            el<HTMLInputElement>('box').click();
            await settle();
            expect(status(), String(gate)).toBeNull();
            expect(form).not.toHaveAttribute('data-submit-dropped');
            document.body.innerHTML = '';
        }
    });

    it('takes the status and the mark away once the form it dropped for is ready', async () => {
        const { form, el } = build('waiting');
        el<HTMLButtonElement>('send').click();
        await settle();
        expect(status()).not.toBeNull();
        form.setAttribute(SUBMIT_GATE_ATTRIBUTE, 'ready');
        await settle();
        expect(status()).toBeNull();
        expect(form).not.toHaveAttribute('data-submit-dropped');
    });
});

describe('SUBMIT_GATE_SCRIPT, when the form turns ready', () => {
    it('never sends a submit it dropped before: not a press, not Enter, not requestSubmit', async () => {
        const { form, reached, el } = build('waiting');
        const send = el<HTMLButtonElement>('send');
        // Every submit event the form gets from here on, seen first at window, ahead of the gate, and any native submit().
        let submits = 0;
        const count = () => (submits += 1);
        window.addEventListener('submit', count, true);
        const native = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined);
        try {
            send.click();
            // Enter in a field is the browser's implicit submission, a submit event at the form with the default
            // button as its submitter, which jsdom doesn't make from a key press.
            form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: send }));
            form.requestSubmit();
            form.requestSubmit(send);
            expect(reached, 'dropped while waiting').not.toHaveBeenCalled();
            submits = 0;
            form.setAttribute(SUBMIT_GATE_ATTRIBUTE, 'ready');
            // The marks go on a MutationObserver's microtask and the words on a timer: flush both, twice over.
            await settle();
            await new Promise<void>((done) => queueMicrotask(done));
            await settle();
            expect(submits, 'submit events after the form turned ready').toBe(0);
            expect(reached, "the form's handler after it turned ready").not.toHaveBeenCalled();
            expect(native, 'a native submit after it turned ready').not.toHaveBeenCalled();
        } finally {
            window.removeEventListener('submit', count, true);
            native.mockRestore();
        }
    });
});

describe('SUBMIT_GATE_SCRIPT, the scope guard', () => {
    it('never touches a form without the attribute, as sign-in, Apply filters or Refresh', () => {
        const { form, reached, arrivedCancelled, el } = build(null);
        el<HTMLButtonElement>('send').click();
        form.requestSubmit();
        form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
        expect(reached).toHaveBeenCalledTimes(3);
        expect(arrivedCancelled).toEqual([false, false, false]);
        for (const id of ['box', 'radio', 'row']) {
            el<HTMLInputElement>(id).click();
            expect(el<HTMLInputElement>(id).checked, id).toBe(true);
        }
        expect(cancelled(el('text'), beforeinput())).toBe(false);
        expect(cancelled(el('area'), beforeinput())).toBe(false);
        expect(cancelled(el('select'), keydown('ArrowDown'))).toBe(false);
        expect(cancelled(el('select'), mousedown())).toBe(false);
    });

    it('never touches a control outside every form, or a checkbox inside an opted-in form that belongs to another one', () => {
        document.body.innerHTML = `
            <input id="loose" type="checkbox">
            <form id="other" method="post"></form>
            <form ${SUBMIT_GATE_ATTRIBUTE}="waiting"><input id="elsewhere" type="checkbox" form="other"></form>`;
        for (const id of ['loose', 'elsewhere']) {
            (document.getElementById(id) as HTMLInputElement).click();
            expect((document.getElementById(id) as HTMLInputElement).checked, id).toBe(true);
        }
    });

    it('sets nothing on the document and keeps its names off window', () => {
        expect(root.getAttributeNames().sort()).toEqual(rootAttributes);
        expect(Object.keys(window).sort()).toEqual(windowKeys);
    });
});
