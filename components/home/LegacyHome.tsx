'use client';

import type { AboutPortraitView } from '@/lib/siteConfig/portraitVariants';
import HomeView from './HomeView';
import { useLegacyHomePhotos } from './useLegacyHomePhotos';

/**
 * Home before the cutover, unchanged: #2's legacy photo list feeding
 * HomeView, with About's portrait for the intro and the badge. It serves
 * only in legacy mode, never as a fallback once the catalog is live. #13's
 * legacy-mode removal deletes it.
 */
export default function LegacyHome({ portrait = null }: { portrait?: AboutPortraitView | null }) {
    const { photos, status } = useLegacyHomePhotos();
    return <HomeView photos={photos} photosStatus={status} portrait={portrait} />;
}
