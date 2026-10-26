import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { STATES, STATE_ORDER } from './fixtures';
import PublishScreen from './PublishScreen';

/**
 * `/mockup/publish?state=<name>`: the 16-3 design-gate mockup, one fixture
 * state per URL. Lives on `wip/lead/16-3-mockup` only, outside the curator
 * paths so it needs no session, and is never merged.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Publish screen mockup', robots: { index: false, follow: false } };

interface MockupProps {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PublishMockup({ searchParams }: MockupProps) {
    const params = await searchParams;
    const name = typeof params.state === 'string' ? params.state : STATE_ORDER[0];
    const state = STATES[name];
    if (!state) notFound();
    return <PublishScreen model={state.model} />;
}
