'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ComponentProps, FocusEvent } from 'react';

export type IntentPrefetchLinkProps = Omit<ComponentProps<typeof Link>, 'href' | 'prefetch' | 'onPointerEnter' | 'onTouchStart'> & {
    href: string;
};

/**
 * A Link that prefetches its page only on a visitor's intent (#6 item 9): a
 * pointer coming onto it, focus, or a touch starting on it. Link's own
 * prefetch is off, so coming into view prefetches nothing, and a visitor who
 * only scrolls a list asks for none of its pages. The prefetch is the router's
 * default kind, what Link would have asked for, and the router keeps one per
 * page however often it's asked. A caller's onFocus runs after the prefetch.
 * It renders the same <a> Link does.
 */
export default function IntentPrefetchLink({ href, onFocus, ...rest }: IntentPrefetchLinkProps) {
    const router = useRouter();
    const prefetch = () => router.prefetch(href);
    const focused = (event: FocusEvent<HTMLAnchorElement>) => {
        prefetch();
        onFocus?.(event);
    };
    return <Link {...rest} href={href} prefetch={false} onPointerEnter={prefetch} onFocus={focused} onTouchStart={prefetch} />;
}
