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

/** What Next's announcer read, from a read step: `document.title`, or the first h1's text when the title was empty. */
export function readOf(step: AnnouncerStep): { of: 'title' | 'h1'; value: string | null } | null {
    if (step.kind !== 'read' || step.focus === undefined) return null;
    const match = /^(title|h1) (.*)$/.exec(step.focus);
    if (match === null) return null;
    return { of: match[1] as 'title' | 'h1', value: JSON.parse(match[2]) as string | null };
}

/** The note a next change that met #258 carries, in the report. */
export const LATE_TITLE_NOTE = 'Next read the old title (#258)';

export interface NextChangeVerdict {
    /** 'strict' when Next's first read was the new page's title, or an empty one, so its write was due; else 'late-title'. */
    branch: 'strict' | 'late-title';
    /** Empty when the change passes. */
    problems: string[];
    /** LATE_TITLE_NOTE when the late title was recorded rather than failed. */
    note?: string;
}

/**
 * The verdict on a page change from a log that began just before the click (#257, #258). Next's announcer reads the
 * title once for each new router tree, and writes only when it differs from what it read last. Whatever the branch:
 * the host is never hidden after the click, and whenever it's shown it holds nothing or the new page's name.
 *
 * - **Strict.** Next's first read is the new page's title, or an empty one followed by the first h1: then the new
 *   page's name must be written while the host is shown.
 * - **Late title.** Next's first read is some other title: the new page's title landed after its tree, so Next wrote
 *   nothing (#258). With `lateTitle: 'record'` that passes with LATE_TITLE_NOTE, as long as the title then became the
 *   new page's. With 'fail', the default, it fails.
 *
 * With no read step at all, it fails: the log can't say what Next saw.
 */
export function nextChangeVerdict(steps: readonly AnnouncerStep[], { name, lateTitle = 'fail' }: { name: RegExp; lateTitle?: 'fail' | 'record' }): NextChangeVerdict {
    const problems: string[] = [];
    if (steps.some((step) => step.kind === 'hidden' || step.hidden)) problems.push('the host was hidden after the click');
    // A title step's text is the document's title; every other step carries the host's text.
    const stale = steps.filter((step) => step.kind !== 'title' && !step.hidden && step.text !== '' && !name.test(step.text)).map((step) => step.text);
    if (stale.length > 0) problems.push(`the host was shown holding ${JSON.stringify([...new Set(stale)])}`);
    const reads = steps.map(readOf).filter((read) => read !== null);
    if (reads.length === 0) return { branch: 'strict', problems: [...problems, 'no read of the title after the click'] };
    const first = reads[0];
    const due = first.of === 'title' && (first.value === '' || name.test(first.value ?? ''));
    if (due) {
        if (!spokenOf(steps).some((text) => name.test(text))) problems.push(`Next read ${JSON.stringify(first.value)} and wrote nothing with the new page's name`);
        return { branch: 'strict', problems };
    }
    if (lateTitle === 'fail') return { branch: 'late-title', problems: [...problems, `${LATE_TITLE_NOTE}: it read ${JSON.stringify(first.value)}`] };
    if (!steps.some((step) => step.kind === 'title' && name.test(step.text))) problems.push("the title never became the new page's");
    return { branch: 'late-title', problems, note: LATE_TITLE_NOTE };
}

/**
 * One entry of a title trace (#258), stamped with `performance.now()` when it was taken.
 *
 * - `read`: a read of `document.title`, with every `<title>` in the document then, and each `Next.Metadata` Suspense
 *   boundary in React's current tree.
 * - `added`, `removed`: a `<title>` put into the document or taken out of it, anywhere, with where.
 * - `text`: a `<title>`'s text changed in place.
 * - `push`, `replace`: a history entry pushed or replaced, with its URL. Next's app router pushes in the commit of the
 *   new tree, before its announcer's effect runs, so a push stamps the commit.
 * - `h1`: an `h1` put into the document, with its text.
 */
export interface TitleTraceEntry {
    at: number;
    kind: 'read' | 'added' | 'removed' | 'text' | 'push' | 'replace' | 'h1';
    /** The title read, the title's or h1's text, or the URL. */
    value: string;
    /** For added, removed and text: the `<title>`'s id in this document, from 1 in the order the trace met them. */
    id?: number;
    /** For added and removed: the path of the parent it went into or came out of. */
    where?: string;
    /** For a read: every `<title>` in the document, in tree order. */
    titles?: TitleFact[];
    /** For a read: each `Next.Metadata` Suspense boundary in React's current tree. */
    metadata?: MetadataFact[];
    /** For a read: each of Next's Head components in React's current tree. */
    heads?: HeadFact[];
}

export interface TitleFact {
    id: number;
    /** 'html', or the namespace's last path segment ('svg'). */
    ns: string;
    /** The path from `html` to the title's parent, as `tag#id` steps, `[hidden]` marking a hidden one. */
    path: string;
    text: string;
    /**
     * Whether React owns it, and where its fiber is: 'mounted' when the fiber's return path reaches a root, 'detached'
     * when it doesn't (a deleted fiber), 'none' when the element carries no fiber (React never rendered or adopted it).
     */
    react: 'mounted' | 'detached' | 'none';
    /** The React keys on its fiber's return path, innermost first, which name the Head it's under. */
    keys?: string;
}

export interface MetadataFact {
    /** 'content' when it shows its children, 'fallback' when it's suspended, 'dehydrated' while it waits to hydrate. */
    state: 'content' | 'fallback' | 'dehydrated';
    /** The React keys on its return path, innermost first. */
    keys: string;
}

/**
 * Next's Head (app-router.js), which renders `useDeferredValue(rsc, prefetchRsc ?? rsc)`: a partial prefetched head
 * first, when there is one, then the full head in a later render.
 */
export interface HeadFact {
    /** Its React key, from the head's vary path. */
    key: string;
    /** What its head render tree holds: 'null', '""', 'element', 'array', or a thenable with its status. */
    prefetch: string;
    rsc: string;
    /** Which of the two it rendered in the current tree: 'rsc', 'prefetch', or 'other'. */
    shows: 'rsc' | 'prefetch' | 'other';
}

type Traces = Record<string, { entries: TitleTraceEntry[]; flush: () => void }>;

/**
 * Starts the title trace `key` on this document (#258). Like installAnnouncerLog, it closes over nothing, so
 * Playwright can send it to the page, and it can run before the document has a root element.
 */
export function installTitleTrace(key: string): void {
    const win = window as unknown as { kgTitleTraces?: Traces; kgTitleIds?: WeakMap<Node, number>; kgTitleNext?: number };
    const traces = (win.kgTitleTraces ??= {});
    const ids = (win.kgTitleIds ??= new WeakMap<Node, number>());
    const idOf = (node: Node): number => {
        let found = ids.get(node);
        if (found === undefined) {
            found = win.kgTitleNext = (win.kgTitleNext ?? 0) + 1;
            ids.set(node, found);
        }
        return found;
    };
    const entries: TitleTraceEntry[] = [];
    const isTitle = (node: Node): node is Element => node instanceof Element && node.localName === 'title';
    const titlesIn = (node: Node): Element[] => (isTitle(node) ? [node] : node instanceof Element ? [...node.getElementsByTagName('title')] : []);
    const step = (element: Element): string => `${element.localName}${element.id ? `#${element.id}` : ''}${element.hasAttribute('hidden') ? '[hidden]' : ''}`;
    const pathOf = (node: Node | null): string => {
        const parts: string[] = [];
        for (let at = node; at instanceof Element; at = at.parentElement) parts.unshift(step(at));
        return parts.join('>') || (node === null ? '(none)' : node.nodeName);
    };
    const h1sIn = (node: Node): Element[] => (node instanceof Element ? (node.localName === 'h1' ? [node] : [...node.getElementsByTagName('h1')]) : []);
    const take = (record: MutationRecord, at: number) => {
        if (record.type === 'characterData') {
            const parent = record.target.parentNode;
            if (parent !== null && isTitle(parent)) entries.push({ at, kind: 'text', value: parent.textContent ?? '', id: idOf(parent) });
            return;
        }
        if (isTitle(record.target)) entries.push({ at, kind: 'text', value: record.target.textContent ?? '', id: idOf(record.target) });
        for (const removed of record.removedNodes) for (const title of titlesIn(removed)) entries.push({ at, kind: 'removed', value: title.textContent ?? '', id: idOf(title), where: pathOf(record.target) });
        for (const added of record.addedNodes) {
            for (const title of titlesIn(added)) entries.push({ at, kind: 'added', value: title.textContent ?? '', id: idOf(title), where: pathOf(title.parentNode) });
            for (const h1 of h1sIn(added)) entries.push({ at, kind: 'h1', value: h1.textContent ?? '' });
        }
    };
    const observer = new MutationObserver((batch) => {
        const at = performance.now();
        for (const record of batch) take(record, at);
    });
    observer.observe(document, { childList: true, characterData: true, subtree: true });
    const flush = () => {
        const at = performance.now();
        for (const record of observer.takeRecords()) take(record, at);
    };
    /** The fiber key on an element React made or adopted, and the fiber. */
    const fiberOf = (node: object): { return: unknown } | null => {
        const name = Object.keys(node).find((own) => own.startsWith('__reactFiber$'));
        return name === undefined ? null : ((node as Record<string, { return: unknown }>)[name] ?? null);
    };
    type HeadData = { rsc?: unknown; prefetchRsc?: unknown };
    type Fiber = { tag: number; key: string | null; return: Fiber | null; child: Fiber | null; sibling: Fiber | null; memoizedProps: { name?: unknown; headRenderTree?: { data?: HeadData } } | null; memoizedState: { dehydrated?: unknown; memoizedState?: unknown } | null; stateNode: unknown };
    const keysOf = (fiber: Fiber): { keys: string; root: boolean } => {
        const keys: string[] = [];
        let at: Fiber | null = fiber.return;
        let last: Fiber = fiber;
        for (; at !== null; last = at, at = at.return) if (at.key !== null) keys.push(at.key);
        // HostRoot is tag 3.
        return { keys: keys.join(' < '), root: last.tag === 3 };
    };
    const valueOf = (value: unknown): string => {
        if (value === null) return 'null';
        if (value === '') return '""';
        if (Array.isArray(value)) return 'array';
        if (typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function') return `thenable:${String((value as { status?: unknown }).status ?? 'untracked')}`;
        if (typeof value === 'object' && (value as { $$typeof?: unknown }).$$typeof !== undefined) return 'element';
        return typeof value;
    };
    let heads: HeadFact[] = [];
    const metadataNow = (): MetadataFact[] => {
        heads = [];
        const name = Object.keys(document).find((own) => own.startsWith('__reactContainer$'));
        if (name === undefined) return [];
        const hostRoot = (document as unknown as Record<string, Fiber | undefined>)[name];
        if (hostRoot === undefined) return [];
        const current = (hostRoot.stateNode as { current?: Fiber } | null)?.current ?? hostRoot;
        const found: MetadataFact[] = [];
        const stack: Fiber[] = [current];
        while (stack.length > 0) {
            const fiber = stack.pop() as Fiber;
            // SuspenseComponent is tag 13.
            if (fiber.tag === 13 && fiber.memoizedProps?.name === 'Next.Metadata') {
                const state = fiber.memoizedState === null ? 'content' : fiber.memoizedState.dehydrated ? 'dehydrated' : 'fallback';
                found.push({ state, keys: keysOf(fiber).keys });
            }
            const data = fiber.memoizedProps?.headRenderTree?.data;
            if (data !== undefined && fiber.key !== null) {
                // A function component's first hook is its memoizedState: here useDeferredValue's, the value it rendered.
                const shown = fiber.memoizedState?.memoizedState;
                heads.push({ key: fiber.key, prefetch: valueOf(data.prefetchRsc), rsc: valueOf(data.rsc), shows: shown === data.rsc ? 'rsc' : shown === data.prefetchRsc ? 'prefetch' : 'other' });
            }
            if (fiber.sibling !== null) stack.push(fiber.sibling);
            if (fiber.child !== null) stack.push(fiber.child);
        }
        return found;
    };
    const titlesNow = (): TitleFact[] =>
        [...document.getElementsByTagName('title')].map((title) => {
            const fiber = fiberOf(title) as Fiber | null;
            const where = fiber === null ? null : keysOf(fiber);
            return {
                id: idOf(title),
                ns: title.namespaceURI === 'http://www.w3.org/1999/xhtml' ? 'html' : (title.namespaceURI ?? '').split('/').pop() ?? '',
                path: pathOf(title.parentNode),
                text: title.textContent ?? '',
                react: where === null ? 'none' : where.root ? 'mounted' : 'detached',
                ...(where !== null && { keys: where.keys }),
            };
        });
    const title = Object.getOwnPropertyDescriptor(Document.prototype, 'title');
    const get = title?.get;
    if (title && get) {
        Object.defineProperty(Document.prototype, 'title', {
            ...title,
            get(this: Document) {
                const value = get.call(this) as string;
                flush();
                const metadata = metadataNow();
                entries.push({ at: performance.now(), kind: 'read', value, titles: titlesNow(), metadata, heads });
                return value;
            },
        });
    }
    for (const kind of ['push', 'replace'] as const) {
        const method = kind === 'push' ? 'pushState' : 'replaceState';
        const original = History.prototype[method];
        History.prototype[method] = function (this: History, data: unknown, unused: string, url?: string | URL | null) {
            flush();
            entries.push({ at: performance.now(), kind, value: url === undefined || url === null ? location.href : String(url) });
            return original.call(this, data, unused, url);
        };
    }
    traces[key] = { entries, flush };
}

/** The title trace `key` so far. */
export function readTitleTrace(key: string): TitleTraceEntry[] {
    const trace = (window as unknown as { kgTitleTraces?: Traces }).kgTitleTraces?.[key];
    if (!trace) throw new Error(`No title trace ${key} on this page`);
    trace.flush();
    return trace.entries.map((entry) => ({ ...entry }));
}

/** A trace as one line per entry: `at kind value`, a title's `#id`, and at a read, the titles and metadata boundaries. */
export function describeTrace(entries: readonly TitleTraceEntry[]): string {
    const fact = (title: TitleFact) => `#${title.id} ${title.ns === 'html' ? '' : `${title.ns} `}${title.path} ${JSON.stringify(title.text)} react=${title.react}${title.keys ? ` keys=${title.keys}` : ''}`;
    return entries
        .map((entry) => {
            const head = `${entry.at.toFixed(1)} ${entry.kind}${entry.id === undefined ? '' : ` #${entry.id}`} ${JSON.stringify(entry.value)}${entry.where ? ` @${entry.where}` : ''}`;
            if (entry.kind !== 'read') return head;
            const titles = (entry.titles ?? []).map(fact).join(', ');
            const metadata = (entry.metadata ?? []).map((boundary) => `${boundary.state} keys=${boundary.keys}`).join(', ');
            const heads = (entry.heads ?? []).map((one) => `${one.key} prefetch=${one.prefetch} rsc=${one.rsc} shows=${one.shows}`).join(', ');
            return `${head} titles=[${titles}] metadata=[${metadata}]${entry.heads === undefined ? '' : ` heads=[${heads}]`}`;
        })
        .join('\n');
}
