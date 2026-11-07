'use client';

import Link from 'next/link';
// The app router's own context, the one next/navigation's useRouter() and Link read. Link reads it as this does, and
// renders without it; useRouter() throws when it's empty.
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { useContext, type ComponentProps, type FocusEvent } from 'react';

export type IntentPrefetchLinkProps = Omit<ComponentProps<typeof Link>, 'href' | 'prefetch' | 'onPointerEnter' | 'onTouchStart'> & {
    href: string;
};

/** Whether the visitor asked the browser to save data (`navigator.connection.saveData`, #174), as B9's Viewer reads it. */
function savesData(): boolean {
    if (typeof navigator === 'undefined') return false;
    return (navigator as Navigator & { connection?: { saveData?: unknown } }).connection?.saveData === true;
}

/**
 * A Link that prefetches its page only on a visitor's intent (#6 item 9): a
 * pointer coming onto it, focus, or a touch starting on it. Link's own
 * prefetch is off, so coming into view prefetches nothing. A touch that
 * starts on the link is intent too, so on a phone a scroll whose finger lands
 * on it prefetches its page, as Link's own touch start did. The prefetch is
 * the router's default kind, what Link would have asked for, and the router
 * keeps one per page however often it's asked. With saveData on, nothing is
 * fetched ahead. A caller's onFocus runs after the prefetch. It renders the
 * same <a> Link does.
 *
 * It renders wherever Link does, as Link does: with no app router mounted,
 * as when Work is rendered to a string outside Next (the payload budgets'
 * scale test), it's the same <a> and an intent prefetches nothing, since
 * there's no router to ask.
 */
export default function IntentPrefetchLink({ href, onFocus, ...rest }: IntentPrefetchLinkProps) {
    const router = useContext(AppRouterContext);
    const prefetch = () => {
        if (router !== null && !savesData()) router.prefetch(href);
    };
    const focused = (event: FocusEvent<HTMLAnchorElement>) => {
        prefetch();
        onFocus?.(event);
    };
    return <Link {...rest} href={href} prefetch={false} onPointerEnter={prefetch} onFocus={focused} onTouchStart={prefetch} />;
}
