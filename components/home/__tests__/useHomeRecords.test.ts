import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HomePhoto } from '@/lib/catalog/projections/home';
import { createElement, type ReactNode } from 'react';
import SiteRoutesProvider from '@/components/site/SiteRoutes';
import { homePhotosHref, useHomeRecords } from '../useHomeRecords';

// The records map itself, which CatalogHome's tests can't see: a record for
// a photograph outside the sequence never joins it, whatever the body says.

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const REVISION = `rev_${'a'.repeat(64)}`;
const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const record = (n: number): HomePhoto => ({ id: id(n), alt: `Photograph ${n}`, focalPoint: { x: 0.5, y: 0.5 }, image: null });
const ORDER = [0, 1, 2, 3, 4, 5].map(id);

const flush = () =>
    act(async () => {
        for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    });

afterEach(() => {
    vi.restoreAllMocks();
});

describe('useHomeRecords', () => {
    it('keeps records for photographs outside the sequence out of the map, and still takes the ones inside it', async () => {
        const outsider = id(99);
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ revisionId: REVISION, photos: [record(2), record(3), { ...record(4), id: outsider }, record(4)] }) }) as unknown as Response);
        const { result } = renderHook(() => useHomeRecords({ revisionId: REVISION, photoIds: ORDER, initial: [record(1), record(2), record(3)], index: 2 }));
        await flush();
        expect(result.current.records.has(id(4))).toBe(true);
        expect(result.current.records.has(outsider)).toBe(false);
        expect([...result.current.records.keys()].every((key) => ORDER.includes(key))).toBe(true);
    });

    it("asks the public endpoint on the site, and the preview's mirror inside #16's preview", async () => {
        expect(homePhotosHref(id(4), REVISION)).toBe(`/api/catalog/home/photos/${id(4)}?revision=${REVISION}`);
        const base = `/curation/preview/${REVISION}/site`;
        const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ revisionId: REVISION, photos: [record(3), record(4), record(5)] }) }) as unknown as Response);
        const wrapper = ({ children }: { children: ReactNode }) => createElement(SiteRoutesProvider, { basePath: base, children });
        renderHook(() => useHomeRecords({ revisionId: REVISION, photoIds: ORDER, initial: [record(1), record(2), record(3)], index: 2 }), { wrapper });
        await flush();
        expect(fetch.mock.calls.length).toBeGreaterThan(0);
        for (const [url] of fetch.mock.calls) expect(String(url)).toMatch(new RegExp(`^${base}/api/catalog/home/photos/`));
    });
});
