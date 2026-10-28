import LoadingState from '@/components/site/LoadingState';

/**
 * The Inbox's loading state: the shared wait, whose label shows only after a
 * second. It reads nothing. It streams before the page runs
 * requireCurator(), so a refusal the page itself made would arrive as a
 * client-side not-found in a 200. proxy.ts refuses every such request first,
 * with the same policy and the precise status, so none reaches the page.
 */
export default function InboxLoading() {
    return <LoadingState label="Loading the inbox" />;
}
