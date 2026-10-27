'use client';

import { createContext, useContext } from 'react';
import type { Answer, Intent } from '@/lib/curation/publish-facts';

/**
 * 15-4: what the Publish screen's own answer means for History below it. The
 * screen provides its latest result and whether a press is pending, so
 * History can pause its Restore buttons while Validate or Publish waits, and
 * show the history an answer that moved the pointer carries (spec, History
 * by 16-3 state).
 */
export interface PublishAnswerState {
    result: Answer | null;
    pending: boolean;
    sent: Intent | null;
}

export const PublishAnswerContext = createContext<PublishAnswerState>({ result: null, pending: false, sent: null });

export const usePublishAnswer = () => useContext(PublishAnswerContext);
