'use server';

import type { PublishState } from '@/lib/curation/publish-facts';

/** The mockup's stand-in for 16-3's publishAction: it answers nothing, so the screen keeps its fixture state. Not for merge. */
export async function mockPublishAction(previous: PublishState): Promise<PublishState> {
    return previous;
}
