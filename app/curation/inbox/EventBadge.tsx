import { CircleAlert, RefreshCw, RotateCcw, UploadCloud, type LucideIcon } from 'lucide-react';
import styles from '../curator.module.css';
import type { CurationEventType } from '@/lib/curation/events';
import { BADGE_LABELS } from '@/lib/curation/inbox-view';

const ICONS: Record<CurationEventType, LucideIcon> = {
    new: UploadCloud,
    replacement: RefreshCw,
    reappeared: RotateCcw,
    missing: CircleAlert,
    ambiguous: CircleAlert,
    'processing-failure': CircleAlert,
};

const TONES: Record<CurationEventType, 'new' | 'change' | 'alert'> = {
    new: 'new',
    replacement: 'change',
    reappeared: 'change',
    missing: 'alert',
    ambiguous: 'alert',
    'processing-failure': 'alert',
};

/** An item's type, as an icon and its name, never color alone. A settled item's alert reads quiet, since nothing is wrong now. */
export default function EventBadge({ type, settled = false }: { type: CurationEventType; settled?: boolean }) {
    const Icon = ICONS[type];
    const tone = settled && TONES[type] === 'alert' ? 'settled' : TONES[type];
    return (
        <span className={styles.badge} data-tone={tone}>
            <Icon size={15} aria-hidden="true" />
            {BADGE_LABELS[type]}
        </span>
    );
}
