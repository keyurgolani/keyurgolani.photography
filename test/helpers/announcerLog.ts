// Next's route announcer as a screen reader meets it (#247, #255): every write to the text of
// <next-route-announcer>'s shadow root, with whether the host was aria-hidden at that moment, every change to that
// aria-hidden, and every focus move, in the order they happened. One MutationObserver takes the hosts' aria-hidden and
// their shadow roots' text, so its records keep the order of the DOM changes, and each record's old value gives the
// value the change before it left, so two writes in one task stay apart. A focus move takes the records still queued
// first, so it lands in that order too. Both functions run in the page (or jsdom) and close over nothing, so
// Playwright can send them there (e2e/support/announcerLog.ts). Here, not under e2e/, so the unit tests that run
// Next's real announcer can read the same log: the image build drops e2e/.

/** One step of the log. `text` and `hidden` are the host's after the step. */
export interface AnnouncerStep {
    kind: 'text' | 'hidden' | 'focus' | 'title' | 'read';
    /** The host's shadow-root text after the step, or for a title step, the document's title it set. */
    text: string;
    /** Whether the host was aria-hidden="true" after the step. */
    hidden: boolean;
    /** For a focus step: the focused element's id, or its tag name when it has none. */
    focus?: string;
}

type Logs = Record<string, { observer: MutationObserver; records: MutationRecord[]; marks: Map<number, string[]>; hosts: Element[]; texts: Map<Node, { host: Element; value: string }> }>;

/**
 * Starts the log `key`, for the hosts there now and any that are appended to body later. With `titles`, it also takes
 * each change to the document's `<title>`, in the same order, since Next's announcer reads the title in its effect,
 * and each read of `document.title`, or of the page's first `h1`, which is what that effect reads, with the value.
 */
export function installAnnouncerLog(options: string | { key: string; titles?: boolean }): void {
    const { key, titles = false } = typeof options === 'string' ? { key: options } : options;
    const logs = ((window as unknown as { kgAnnouncerLogs?: Logs }).kgAnnouncerLogs ??= {});
    const records: MutationRecord[] = [];
    const marks = new Map<number, string[]>();
    const hosts: Element[] = [];
    /** The text nodes in the hosts' shadow roots when the log started, with their values then. */
    const texts = new Map<Node, { host: Element; value: string }>();
    const observer = new MutationObserver((batch) => {
        for (const record of batch) take(record);
    });
    const watch = (host: Element, atStart: boolean) => {
        if (hosts.includes(host)) return;
        hosts.push(host);
        observer.observe(host, { attributes: true, attributeFilter: ['aria-hidden'], attributeOldValue: true });
        const root = host.shadowRoot;
        if (root === null) return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        if (atStart) for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) texts.set(node, { host, value: (node as Text).data });
        observer.observe(root, { childList: true, characterData: true, characterDataOldValue: true, subtree: true });
    };
    const take = (record: MutationRecord) => {
        records.push(record);
        if (record.target === document.body) for (const added of record.addedNodes) if (added instanceof Element && added.localName === 'next-route-announcer') watch(added, false);
    };
    const start = () => {
        for (const host of document.getElementsByTagName('next-route-announcer')) watch(host, true);
        observer.observe(document.body, { childList: true });
        if (titles && document.head !== null) observer.observe(document.head, { childList: true, characterData: true, characterDataOldValue: true, subtree: true });
    };
    if (document.body === null) document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
    const mark = (entry: string) => {
        for (const record of observer.takeRecords()) take(record);
        marks.set(records.length, [...(marks.get(records.length) ?? []), entry]);
    };
    if (titles) {
        const title = Object.getOwnPropertyDescriptor(Document.prototype, 'title');
        const get = title?.get;
        if (title && get) {
            Object.defineProperty(Document.prototype, 'title', {
                ...title,
                get(this: Document) {
                    const value = get.call(this) as string;
                    mark(`\u0000read title ${JSON.stringify(value)}`);
                    return value;
                },
            });
        }
        const query = Document.prototype.querySelector;
        Document.prototype.querySelector = function (this: Document, selectors: string) {
            const found = query.call(this, selectors);
            if (selectors === 'h1') mark(`\u0000read h1 ${JSON.stringify(found?.textContent ?? null)}`);
            return found;
        } as typeof Document.prototype.querySelector;
    }
    document.addEventListener(
        'focusin',
        (event) => {
            for (const record of observer.takeRecords()) take(record);
            const target = event.target instanceof Element ? event.target : null;
            const name = target === null ? 'none' : target.id || target.localName;
            marks.set(records.length, [...(marks.get(records.length) ?? []), name]);
        },
        true,
    );
    logs[key] = { observer, records, marks, hosts, texts };
}

/** The log `key` so far, replayed. With more than one host, a step reads the host it touched. */
export function readAnnouncerLog(key: string): AnnouncerStep[] {
    const log = (window as unknown as { kgAnnouncerLogs?: Logs }).kgAnnouncerLogs?.[key];
    if (!log) throw new Error(`No announcer log ${key} on this page`);
    for (const record of log.observer.takeRecords()) {
        log.records.push(record);
        if (record.target === document.body) for (const added of record.addedNodes) if (added instanceof Element && added.localName === 'next-route-announcer' && !log.hosts.includes(added)) log.hosts.push(added);
    }
    const { records, marks } = log;
    const hostOf = (node: Node): Element | null => {
        const root = node.getRootNode();
        return root instanceof ShadowRoot ? root.host : node instanceof Element && node.localName === 'next-route-announcer' ? node : null;
    };
    /** The value `node` had right after record `index` changed it: the next record's old value, else what it holds now. */
    const textAfter = (node: Node, index: number): string => {
        for (let next = index + 1; next < records.length; next++) if (records[next].type === 'characterData' && records[next].target === node) return records[next].oldValue ?? '';
        return (node as Text).data;
    };
    const hiddenAfter = (host: Element, index: number): boolean => {
        for (let next = index + 1; next < records.length; next++) if (records[next].type === 'attributes' && records[next].target === host) return records[next].oldValue === 'true';
        return host.getAttribute('aria-hidden') === 'true';
    };
    /** What a host held before the first record: its first record's old values, else what it holds now. */
    const hidden = new Map<Element, boolean>();
    const values = new Map<Node, string>();
    const owner = new Map<Node, Element>();
    const firstHidden = (host: Element): boolean => {
        const first = records.find((record) => record.type === 'attributes' && record.target === host);
        return first ? first.oldValue === 'true' : host.getAttribute('aria-hidden') === 'true';
    };
    const firstText = (node: Node, from: number): string => {
        for (let next = from; next < records.length; next++) if (records[next].type === 'characterData' && records[next].target === node) return records[next].oldValue ?? '';
        return (node as Text).data;
    };
    /** Whether a record from `from` on added `node`, or a node it sits in. */
    const addedLater = (node: Node, from: number) => records.slice(from).some((record) => [...record.addedNodes].some((added) => added === node || added.contains(node)));
    /**
     * A host there when the log started holds the text it held then. One appended later holds what its shadow root
     * holds now but for what a later record added, at the value before that node's first change.
     */
    const meet = (host: Element, from: number, atStart: boolean) => {
        if (hidden.has(host)) return;
        hidden.set(host, firstHidden(host));
        if (atStart) {
            for (const [node, { host: of, value }] of log.texts) {
                if (of !== host) continue;
                values.set(node, value);
                owner.set(node, host);
            }
            return;
        }
        const root = host.shadowRoot;
        if (root === null) return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            if (addedLater(node, from)) continue;
            values.set(node, firstText(node, from));
            owner.set(node, host);
        }
    };
    for (const host of log.hosts) if (!records.some((record) => record.target === document.body && [...record.addedNodes].includes(host))) meet(host, 0, true);
    const textOf = (host: Element) => [...values].filter(([node]) => owner.get(node) === host).map(([, value]) => value).join('');
    const steps: AnnouncerStep[] = [];
    let last: Element | null = log.hosts[0] ?? null;
    const markAt = (index: number) => {
        for (const focus of marks.get(index) ?? []) {
            const state = { text: last === null ? '' : textOf(last), hidden: last === null ? false : (hidden.get(last) ?? false) };
            if (focus.startsWith('\u0000read ')) steps.push({ kind: 'read', focus: focus.slice('\u0000read '.length), ...state });
            else steps.push({ kind: 'focus', focus, ...state });
        }
    };
    /** The title a record in `<head>` set, or null when it touched no `<title>`. */
    const titleSet = (record: MutationRecord, index: number): string | null => {
        const target = record.target;
        if (record.type === 'characterData') return target.parentElement?.localName === 'title' ? textAfter(target, index) : null;
        for (const added of record.addedNodes) if (added instanceof Element && added.localName === 'title') return added.textContent ?? '';
        if (target instanceof Element && target.localName === 'title') return target.textContent ?? '';
        return null;
    };
    records.forEach((record, index) => {
        markAt(index);
        const head = document.head;
        if (head !== null && (record.target === head || head.contains(record.target))) {
            const title = titleSet(record, index);
            if (title !== null) steps.push({ kind: 'title', text: title, hidden: last === null ? false : (hidden.get(last) ?? false) });
            return;
        }
        if (record.target === document.body) {
            for (const added of record.addedNodes) if (added instanceof Element && added.localName === 'next-route-announcer') meet(added, index + 1, false);
            return;
        }
        const host = hostOf(record.target);
        if (host === null) return;
        meet(host, index, false);
        last = host;
        if (record.type === 'attributes') {
            hidden.set(host, hiddenAfter(host, index));
            steps.push({ kind: 'hidden', text: textOf(host), hidden: hidden.get(host) ?? false });
            return;
        }
        if (record.type === 'characterData') {
            values.set(record.target, textAfter(record.target, index));
            owner.set(record.target, host);
        }
        for (const removed of record.removedNodes) {
            const walker = document.createTreeWalker(removed, NodeFilter.SHOW_TEXT);
            if (removed.nodeType === Node.TEXT_NODE) values.delete(removed);
            for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) values.delete(node);
        }
        for (const added of record.addedNodes) {
            const found: Node[] = added.nodeType === Node.TEXT_NODE ? [added] : [];
            const walker = document.createTreeWalker(added, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) found.push(node);
            for (const node of found) {
                values.set(node, firstText(node, index + 1));
                owner.set(node, host);
            }
        }
        steps.push({ kind: 'text', text: textOf(host), hidden: hidden.get(host) ?? false });
    });
    markAt(records.length);
    return steps;
}

/** The texts a screen reader would have been given: each non-empty write while its host wasn't hidden. */
export function spokenOf(steps: readonly AnnouncerStep[]): string[] {
    return steps.filter((step) => step.kind === 'text' && !step.hidden && step.text !== '').map((step) => step.text);
}

/**
 * The texts the host held each time it was shown: a step that took its aria-hidden off while it still held text. That
 * text was written while it was hidden, so it's stale, and a screen reader can read an alert out as it's shown.
 */
export function shownHolding(steps: readonly AnnouncerStep[]): string[] {
    return steps.filter((step) => step.kind === 'hidden' && !step.hidden && step.text !== '').map((step) => step.text);
}

/** The log as one line per step, for a failure message. */
export function describeLog(steps: readonly AnnouncerStep[]): string {
    return steps
        .map((step) => {
            if (step.kind === 'focus') return `focus ${step.focus}`;
            if (step.kind === 'read') return `read ${step.focus}`;
            if (step.kind === 'title') return `title ${JSON.stringify(step.text)}`;
            return `${step.kind} ${JSON.stringify(step.text)}${step.hidden ? ' (hidden)' : ''}`;
        })
        .join('; ');
}
