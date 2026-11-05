import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkCatalog, WorkSeriesSummary } from '@/lib/catalog/projections/work';
import SeriesCatalog from '../SeriesCatalog';

// Work's intent prefetch (#6 item 9, B10): no entry prefetches its series because it came into view, so a visitor
// who only scrolls Work asks for no series page (#171's 375 by 812 check). Pointing at, focusing or touching an
// entry's link prefetches that series alone. Link is stubbed so its prefetch prop shows as an attribute.

const router = vi.hoisted(() => ({ prefetch: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => router }));

vi.mock('next/link', () => ({
    default: ({ href, prefetch, children, ...rest }: { href: string; prefetch?: boolean | null; children: ReactNode }) => (
        <a href={href} data-prefetch={String(prefetch)} {...rest}>
            {children}
        </a>
    ),
}));

function series(n: number): WorkSeriesSummary {
    return {
        id: `ser_entry-${n}`,
        slug: `entry-${n}`,
        href: `/work/entry-${n}`,
        title: `Entry ${n}`,
        shortStatement: `Short statement ${n}.`,
        derived: { photoCount: n },
        cover: null,
    };
}

const work = (entries: WorkSeriesSummary[]): WorkCatalog => ({ catalogRevision: `rev_${'a'.repeat(64)}`, series: entries });
const ENTRIES = [series(1), series(2), series(3)];

beforeEach(() => {
    router.prefetch.mockClear();
});

describe('Work\'s intent prefetch', () => {
    it('turns Link\'s own prefetch off on every link in Work, so none prefetches on coming into view', () => {
        render(<SeriesCatalog work={work(ENTRIES)} />);
        const links = within(screen.getByRole('main')).getAllByRole('link');
        expect(links).toHaveLength(ENTRIES.length);
        for (const link of links) expect(link).toHaveAttribute('data-prefetch', 'false');
    });

    it('prefetches nothing as it renders, on the server or in the browser', () => {
        renderToString(<SeriesCatalog work={work(ENTRIES)} />);
        render(<SeriesCatalog work={work(ENTRIES)} />);
        expect(router.prefetch).not.toHaveBeenCalled();
    });

    it('prefetches an entry\'s series, and only that one, when a pointer comes onto its link, it takes focus, or a touch starts on it', () => {
        render(<SeriesCatalog work={work(ENTRIES)} />);
        const link = (n: number) => screen.getByRole('link', { name: `Entry ${n}` });
        fireEvent.pointerEnter(link(2));
        expect(router.prefetch.mock.calls).toEqual([['/work/entry-2']]);
        fireEvent.focus(link(3));
        expect(router.prefetch.mock.calls).toEqual([['/work/entry-2'], ['/work/entry-3']]);
        fireEvent.touchStart(link(1));
        expect(router.prefetch.mock.calls).toEqual([['/work/entry-2'], ['/work/entry-3'], ['/work/entry-1']]);
    });

    it('keeps the entry link as B3 made it: the h2\'s one child, named by the title, described by the statement and count', () => {
        render(<SeriesCatalog work={work(ENTRIES)} />);
        const link = screen.getByRole('link', { name: 'Entry 1' });
        expect(link.parentElement?.tagName).toBe('H2');
        expect(link.parentElement?.childElementCount).toBe(1);
        expect(link).toHaveAccessibleDescription('Short statement 1. 1 photograph');
    });
});
