'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ComponentProps, FocusEvent } from 'react';

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
 */
export default function IntentPrefetchLink({ href, onFocus, ...rest }: IntentPrefetchLinkProps) {
    const router = useRouter();
    const prefetch = () => {
        if (!savesData()) router.prefetch(href);
    };
    const focused = (event: FocusEvent<HTMLAnchorElement>) => {
        prefetch();
        onFocus?.(event);
    };
    return <Link {...rest} href={href} prefetch={false} onPointerEnter={prefetch} onFocus={focused} onTouchStart={prefetch} />;
}
