import { fireEvent, render, screen } from '@testing-library/react';
import type { FocusEvent, ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import IntentPrefetchLink from '../IntentPrefetchLink';

// #6 item 9 (B10): a link that prefetches its page only on a visitor's intent, a pointer coming onto it, focus, or a
// touch starting on it, never because it scrolled into view.

const router = vi.hoisted(() => ({ prefetch: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => router }));

// The props Link gets, as attributes, so a test can see Link's own prefetch is off.
vi.mock('next/link', () => ({
    default: ({ href, prefetch, children, ...rest }: { href: string; prefetch?: boolean | null; children: ReactNode }) => (
        <a href={href} data-prefetch={String(prefetch)} {...rest}>
            {children}
        </a>
    ),
}));

const HREF = '/work/harbor';
const link = () => screen.getByRole('link', { name: 'Fixture harbor' });

beforeEach(() => {
    router.prefetch.mockClear();
});

describe('IntentPrefetchLink', () => {
    it('renders a Link with its own prefetch off, keeping the href, the text and the attributes it gets', () => {
        render(
            <IntentPrefetchLink href={HREF} className="title" aria-describedby="entry-statement">
                Fixture harbor
            </IntentPrefetchLink>,
        );
        expect(link()).toHaveAttribute('href', HREF);
        expect(link()).toHaveAttribute('data-prefetch', 'false');
        expect(link()).toHaveClass('title');
        expect(link()).toHaveAttribute('aria-describedby', 'entry-statement');
        expect(link()).toHaveTextContent(/^Fixture harbor$/);
    });

    it('prefetches nothing when it renders, on the server or in the browser', () => {
        renderToString(<IntentPrefetchLink href={HREF}>Fixture harbor</IntentPrefetchLink>);
        render(<IntentPrefetchLink href={HREF}>Fixture harbor</IntentPrefetchLink>);
        expect(router.prefetch).not.toHaveBeenCalled();
    });

    it.each([
        ['a pointer coming onto it', (element: HTMLElement) => fireEvent.pointerEnter(element)],
        ['focus', (element: HTMLElement) => fireEvent.focus(element)],
        ['a touch starting on it', (element: HTMLElement) => fireEvent.touchStart(element)],
    ])('prefetches its href through the router on %s, with the router\'s own default kind', (_, intent) => {
        render(<IntentPrefetchLink href={HREF}>Fixture harbor</IntentPrefetchLink>);
        intent(link());
        expect(router.prefetch).toHaveBeenCalledTimes(1);
        expect(router.prefetch).toHaveBeenCalledWith(HREF);
    });

    it('prefetches nothing on a pointer leaving it, or on blur', () => {
        render(<IntentPrefetchLink href={HREF}>Fixture harbor</IntentPrefetchLink>);
        fireEvent.pointerLeave(link());
        fireEvent.blur(link());
        expect(router.prefetch).not.toHaveBeenCalled();
    });

    it('runs the caller\'s own onFocus too, after the prefetch, with the focus event', () => {
        // React clears currentTarget once the handler returns, so it's read inside.
        const onFocus = vi.fn((event: FocusEvent<HTMLAnchorElement>) => ({ type: event.type, target: event.currentTarget }));
        render(
            <IntentPrefetchLink href={HREF} onFocus={onFocus}>
                Fixture harbor
            </IntentPrefetchLink>,
        );
        fireEvent.focus(link());
        expect(router.prefetch).toHaveBeenCalledWith(HREF);
        expect(onFocus).toHaveBeenCalledTimes(1);
        expect(onFocus.mock.results[0].value).toEqual({ type: 'focus', target: link() });
        expect(router.prefetch.mock.invocationCallOrder[0]).toBeLessThan(onFocus.mock.invocationCallOrder[0]);
    });

    it('prefetches the href it has now, after a render that changed it', () => {
        const { rerender } = render(<IntentPrefetchLink href={HREF}>Fixture harbor</IntentPrefetchLink>);
        rerender(<IntentPrefetchLink href="/work/ridge">Fixture harbor</IntentPrefetchLink>);
        fireEvent.pointerEnter(link());
        expect(router.prefetch).toHaveBeenCalledWith('/work/ridge');
    });
});
