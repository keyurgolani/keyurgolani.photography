'use client';

import HomeView from '../components/home/HomeView';
import { useLegacyHomePhotos } from '../components/home/useLegacyHomePhotos';

export default function Home() {
    return <HomeView photos={useLegacyHomePhotos()} />;
}
