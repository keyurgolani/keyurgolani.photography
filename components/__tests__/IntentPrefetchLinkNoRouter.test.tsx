import { fireEvent, render, screen } from '@testing-library/react';
import Link from 'next/link';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import IntentPrefetchLink from '../IntentPrefetchLink';
import WorkEntryLink from '../work/WorkEntryLink';

// Work's entry links render wherever SeriesCatalog renders, as Link does: in the app router, and outside it too, as
// the payload budgets' scale test renders Work to a string (lib/perf/__tests__/budgets.test.ts). Outside the app
// router there's nothing to prefetch through, so an intent does nothing. Nothing here mocks next/navigation or
// next/link: this is the harness with no router mounted.

const HREF = '/work/harbor';

describe('IntentPrefetchLink with no app router mounted', () => {
    it('renders on the server to the <a> Link renders with its own prefetch off', () => {
        const props = { className: 'title', 'aria-describedby': 'entry-statement' };
        const ours = renderToStaticMarkup(
            <IntentPrefetchLink href={HREF} {...props}>
                Fixture harbor
            </IntentPrefetchLink>,
        );
        const links = renderToStaticMarkup(
            <Link href={HREF} prefetch={false} {...props}>
                Fixture harbor
            </Link>,
        );
        expect(ours).toBe(links);
        expect(ours).toContain(`href="${HREF}"`);
    });

    it('renders Work\'s entry link on the server too', () => {
        expect(renderToStaticMarkup(<WorkEntryLink href={HREF}>Fixture harbor</WorkEntryLink>)).toBe(renderToStaticMarkup(<Link href={HREF} prefetch={false}>Fixture harbor</Link>));
    });

    it('renders in the browser, and a pointer, focus or touch on it does nothing', () => {
        render(<IntentPrefetchLink href={HREF}>Fixture harbor</IntentPrefetchLink>);
        const link = screen.getByRole('link', { name: 'Fixture harbor' });
        // React reports a handler's throw to the window, not to the dispatch, so the window's errors are read too.
        const errors: unknown[] = [];
        const onError = (event: ErrorEvent) => {
            errors.push(event.error);
            event.preventDefault();
        };
        window.addEventListener('error', onError);
        try {
            expect(() => {
                fireEvent.pointerEnter(link);
                fireEvent.focus(link);
                fireEvent.touchStart(link);
            }).not.toThrow();
        } finally {
            window.removeEventListener('error', onError);
        }
        expect(errors).toEqual([]);
        expect(link).toHaveAttribute('href', HREF);
    });
});
