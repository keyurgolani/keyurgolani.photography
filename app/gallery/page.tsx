import type { Metadata } from 'next';
import { permanentRedirect, redirect } from 'next/navigation';
import React from 'react';
import DynamicGallery from '../../components/DynamicGallery';
import SiteNav from '../../components/site/SiteNav';
import { workRouteOf } from '../../lib/catalog/projections/work';
import { CatalogUnavailableError, getActiveCatalog, publicRoutes } from '../../lib/catalog/public-reader';

export const metadata: Metadata = { title: 'Gallery' };

// Per request: the cutover is a fact of the data root, which the build never sees.
export const dynamic = 'force-dynamic';

/**
 * The legacy archive, kept for legacy mode until #13 removes it. Once a
 * revision is served it answers 308 to /work. While the catalog is
 * unavailable it throws, so #21's error page renders and no cached 308 can
 * pair with a later legacy 307 on /work.
 */
export default async function GalleryPage() {
    const result = workRouteOf('gallery', await getActiveCatalog(), publicRoutes);
    switch (result.kind) {
        case 'redirect':
            return result.status === 308 ? permanentRedirect(result.location) : redirect(result.location);
        case 'unavailable':
            throw new CatalogUnavailableError(result.reason);
        case 'work':
            // Only /work answers this.
            throw new TypeError('workRouteOf(gallery) answered work');
        case 'legacy-gallery':
            return (
                <>
                    {/* Outside main, so the nav landmark isn't part of the page's content. */}
                    <SiteNav />
                    <main className="min-h-screen bg-background">
                        <div className="w-full max-w-[2000px] mx-auto px-4 sm:px-6 lg:px-8 pt-8">
                            <h1 className="text-4xl font-bold text-center mb-10 font-primary">Gallery</h1>
                            <DynamicGallery />
                        </div>
                    </main>
                </>
            );
    }
}
