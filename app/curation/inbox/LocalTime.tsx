'use client';

import { useSyncExternalStore } from 'react';
import { humanTime } from '@/lib/curation/inbox-view';

const never = () => () => undefined;
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const serverZone = () => 'UTC';

/**
 * A stored timestamp in the Inbox's words, with the stored value in
 * `dateTime`. The server sends it in UTC; once the page runs it reads in the
 * browser's own zone, which is the owner's. It's a leaf, so its one render
 * after hydration touches nothing else.
 */
export default function LocalTime({ at }: { at: string }) {
    const zone = useSyncExternalStore(never, browserZone, serverZone);
    return <time dateTime={at}>{humanTime(at, zone)}</time>;
}
