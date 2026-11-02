import { ImageOff } from 'lucide-react';
import styles from '../curator.module.css';

/** 56 CSS px square, as the Inbox's rows are, so a row is the same height whether its thumbnail has loaded or there's none. */
const THUMB = 56;

/**
 * A photograph's thumbnail on a series' page (#150's 2b): the ready set's
 * w400 WebP from the curator-only route, as the Inbox's rows show it. Its
 * alt is empty, since the name beside it names the photograph. With no
 * ready set, a neutral square holds its place.
 */
export default function Thumbnail({ url }: { url: string | null }) {
    if (url === null) {
        return (
            <span className={styles.thumb} data-thumb="none" aria-hidden="true">
                <ImageOff size={18} />
            </span>
        );
    }
    return <img className={styles.thumb} src={url} alt="" width={THUMB} height={THUMB} loading="lazy" decoding="async" />;
}
