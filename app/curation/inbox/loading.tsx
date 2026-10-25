import LoadingState from '@/components/site/LoadingState';

/** The Inbox's loading state: the shared wait, whose label shows only after a second. It reads nothing. */
export default function InboxLoading() {
    return <LoadingState label="Loading the inbox" />;
}
