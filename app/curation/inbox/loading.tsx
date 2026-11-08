import LoadingState from '@/components/site/LoadingState';
import curator from '../curator.module.css';

/**
 * The Inbox's loading state: the shared wait, whose label shows only after a
 * second. It reads nothing. It streams before the page runs
 * requireCurator(), so a refusal the page itself made would arrive as a
 * client-side not-found in a 200. proxy.ts refuses every such request first,
 * with the same policy and the precise status, so none reaches the page.
 *
 * Without JavaScript the Inbox never leaves this state: the list and the
 * header, with Sign out, stream into hidden segments that only React's own
 * script moves into place. So a <noscript> line says so, in Publish's words,
 * after the status region and outside it, so the status reads only its label.
 */
export default function InboxLoading() {
    return (
        <>
            <LoadingState label="Loading the inbox" />
            <noscript>
                <p className={curator.noScriptNote}>The Inbox and its header, with Sign out, need JavaScript. Nothing is written without it.</p>
            </noscript>
        </>
    );
}
