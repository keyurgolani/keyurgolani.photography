'use client';

import HomeView from './HomeView';
import { useLegacyHomePhotos } from './useLegacyHomePhotos';

/**
 * Home before the cutover, unchanged: #2's legacy photo list feeding
 * HomeView. It serves only in legacy mode, never as a fallback once the
 * catalog is live. #13's legacy-mode removal deletes it.
 */
export default function LegacyHome() {
    const { photos, status } = useLegacyHomePhotos();
    return <HomeView photos={photos} photosStatus={status} />;
}
