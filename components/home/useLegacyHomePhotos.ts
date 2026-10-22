'use client';

import { useEffect, useState } from 'react';
import { photoImageAlt } from '@/lib/a11y/photoName';
import type { ImageItem } from '@/utils/getImageData';
import { getCachedHomeHeroImages, setCachedHomeHeroImages } from '@/utils/homeHeroCache';
import type { HomePhoto } from './homePhoto';

/** How long a preload link stays in the head. */
const PRELOAD_LINK_MS = 15000;

// Fisher-Yates shuffle algorithm for randomizing array order
function shuffleArray<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

/** Keeps the photographs already shown in their order, drops removed ones, and shuffles new ones onto the end. */
function mergeCarouselImages(existing: HomePhoto[], latest: HomePhoto[]): HomePhoto[] {
    if (existing.length === 0) {
        return shuffleArray(latest);
    }

    const latestById = new Map(latest.map((photo) => [photo.id, photo]));
    const retained = existing.filter((photo) => latestById.has(photo.id)).map((photo) => latestById.get(photo.id)!);
    const retainedIds = new Set(retained.map((photo) => photo.id));
    const added = latest.filter((photo) => !retainedIds.has(photo.id));

    return added.length > 0 ? [...retained, ...shuffleArray(added)] : retained;
}

const toHomePhoto = (item: ImageItem): HomePhoto => ({
    id: item.src,
    accessibleName: '',
    sources: { thumbnail: item.thumbnail, full: item.optimized },
    width: item.width,
    height: item.height,
});

/** #1's legacy names, numbered once the merge has settled the order. */
const withNames = (photos: HomePhoto[]): HomePhoto[] =>
    photos.map((photo, index) => ({ ...photo, accessibleName: photoImageAlt({ position: index + 1, total: photos.length }) }));

const samePhotos = (a: HomePhoto[], b: HomePhoto[]) =>
    a.length === b.length &&
    a.every((photo, i) => {
        const other = b[i];
        return (
            photo.id === other.id &&
            photo.accessibleName === other.accessibleName &&
            photo.sources.thumbnail === other.sources.thumbnail &&
            photo.sources.full === other.sources.full &&
            photo.width === other.width &&
            photo.height === other.height
        );
    });

/**
 * Home's photographs from /api/photos, until #13's catalog replaces it. A
 * return visit in the tab shows the cached list at once and refreshes it in
 * the background. The array changes only when the merged list does.
 */
export function useLegacyHomePhotos(): HomePhoto[] {
    const [photos, setPhotos] = useState<HomePhoto[]>(() => getCachedHomeHeroImages());

    useEffect(() => {
        let active = true;
        const links: HTMLLinkElement[] = [];
        const timers: ReturnType<typeof setTimeout>[] = [];

        // Preload the first two full-quality images for LCP, and drop the links after a while.
        const preload = (urls: string[]) => {
            urls.slice(0, 2).forEach((url, index) => {
                const link = document.createElement('link');
                link.rel = 'preload';
                link.as = 'image';
                link.href = url;
                link.setAttribute('fetchpriority', index === 0 ? 'high' : 'auto');
                document.head.appendChild(link);
                links.push(link);
                timers.push(setTimeout(() => link.remove(), PRELOAD_LINK_MS));
            });
        };

        const fetchPhotos = async () => {
            try {
                const response = await fetch('/api/photos');
                if (!response.ok) {
                    throw new Error('Failed to fetch images');
                }
                const data: ImageItem[] = await response.json();
                const merged = withNames(mergeCarouselImages(getCachedHomeHeroImages(), data.map(toHomePhoto)));
                setCachedHomeHeroImages(merged);
                if (!active) return;
                setPhotos((current) => (samePhotos(current, merged) ? current : merged));
                if (merged.length > 0) preload(merged.map((photo) => photo.sources.full));
            } catch (error) {
                console.error('Error fetching gallery images:', error);
                if (active && getCachedHomeHeroImages().length === 0) {
                    setPhotos((current) => (current.length === 0 ? current : []));
                }
            }
        };

        fetchPhotos();

        return () => {
            active = false;
            timers.forEach(clearTimeout);
            links.forEach((link) => link.remove());
        };
    }, []);

    return photos;
}
