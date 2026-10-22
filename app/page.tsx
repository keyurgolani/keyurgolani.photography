'use client';

import HomeView from '../components/home/HomeView';
import { useLegacyHomePhotos } from '../components/home/useLegacyHomePhotos';

export default function Home() {
    const { photos, status } = useLegacyHomePhotos();
    return <HomeView photos={photos} photosStatus={status} />;
}
