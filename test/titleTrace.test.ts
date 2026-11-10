import { afterEach, describe, expect, it } from 'vitest';
import { describeTrace, installTitleTrace, readTitleTrace } from './helpers/announcerLog';

// The title trace (#258) the series-announcements spec writes into its report, on jsdom: titles put in and taken out
// anywhere, reads of document.title with every <title> and each Next.Metadata boundary, and history pushes.

type FakeFiber = { tag: number; key: string | null; return: FakeFiber | null; child: FakeFiber | null; sibling: FakeFiber | null; memoizedProps: { name?: string } | null; memoizedState: object | null; stateNode: unknown };
const fiber = (tag: number, key: string | null, parent: FakeFiber | null, extra: Partial<FakeFiber> = {}): FakeFiber => ({ tag, key, return: parent, child: null, sibling: null, memoizedProps: null, memoizedState: null, stateNode: null, ...extra });

let count = 0;
const flushed = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
});

describe('installTitleTrace', () => {
    it('logs a title put in, its text changed, and taken out, anywhere in the document, by one id', async () => {
        const key = `t-${++count}`;
        installTitleTrace(key);
        const title = document.createElement('title');
        title.textContent = 'Fixture swell · Site';
        const hidden = document.createElement('div');
        hidden.hidden = true;
        hidden.append(title);
        document.body.append(hidden);
        await flushed();
        title.firstChild!.textContent = 'Work · Site';
        await flushed();
        hidden.remove();
        const trace = readTitleTrace(key);
        expect(trace.map(({ kind, value, id, where }) => ({ kind, value, id, where }))).toEqual([
            { kind: 'added', value: 'Fixture swell · Site', id: trace[0].id, where: 'html>body>div[hidden]' },
            { kind: 'text', value: 'Work · Site', id: trace[0].id, where: undefined },
            { kind: 'removed', value: 'Work · Site', id: trace[0].id, where: 'html>body' },
        ]);
        expect(trace.every((entry) => typeof entry.at === 'number')).toBe(true);
    });

    it('takes, at a read, every <title> with its owner, and each Next.Metadata boundary\'s state', () => {
        const key = `t-${++count}`;
        const root = fiber(3, null, null);
        const head = fiber(0, 'head-key', root);
        const shown = fiber(13, null, head, { memoizedProps: { name: 'Next.Metadata' } });
        const pending = fiber(13, null, head, { memoizedProps: { name: 'Next.Metadata' }, memoizedState: {} });
        const other = fiber(13, null, head, { memoizedProps: { name: 'Other' }, memoizedState: {} });
        root.child = head;
        head.child = shown;
        shown.sibling = pending;
        pending.sibling = other;
        root.stateNode = { current: root };
        (document as unknown as Record<string, unknown>)['__reactContainer$test'] = root;
        const owned = document.createElement('title');
        owned.textContent = 'Work · Site';
        (owned as unknown as Record<string, unknown>)['__reactFiber$test'] = fiber(26, null, shown);
        const dropped = document.createElement('title');
        dropped.textContent = 'Fixture swell · Site';
        (dropped as unknown as Record<string, unknown>)['__reactFiber$test'] = fiber(26, null, fiber(13, 'old-head', null));
        const foreign = document.createElement('title');
        foreign.textContent = 'Fixture swell · Site';
        document.head.append(owned, dropped);
        document.body.append(foreign);
        installTitleTrace(key);
        expect(document.title).toBe('Work · Site');
        const read = readTitleTrace(key).find((entry) => entry.kind === 'read');
        expect(read?.value).toBe('Work · Site');
        expect(read?.titles?.map(({ path, text, react, keys }) => ({ path, text, react, keys }))).toEqual([
            { path: 'html>head', text: 'Work · Site', react: 'mounted', keys: 'head-key' },
            { path: 'html>head', text: 'Fixture swell · Site', react: 'detached', keys: 'old-head' },
            { path: 'html>body', text: 'Fixture swell · Site', react: 'none', keys: undefined },
        ]);
        expect(read?.metadata).toEqual([
            { state: 'content', keys: 'head-key' },
            { state: 'fallback', keys: 'head-key' },
        ]);
    });

    it('stamps each history push and replace with its URL, and each h1 put in', () => {
        const key = `t-${++count}`;
        installTitleTrace(key);
        history.pushState(null, '', '/work');
        const h1 = document.createElement('h1');
        h1.textContent = 'Bodies of work';
        document.body.append(h1);
        history.replaceState(null, '', '/work?x=1');
        expect(readTitleTrace(key).map(({ kind, value }) => `${kind} ${value}`)).toEqual(['push /work', 'h1 Bodies of work', 'replace /work?x=1']);
    });

    it('describes a read on one line, with its titles and boundaries', () => {
        const line = describeTrace([{ at: 12.34, kind: 'read', value: 'S', titles: [{ id: 2, ns: 'html', path: 'html>head', text: 'S', react: 'none' }], metadata: [{ state: 'fallback', keys: 'k' }] }]);
        expect(line).toBe('12.3 read "S" titles=[#2 html>head "S" react=none] metadata=[fallback keys=k]');
    });
});
