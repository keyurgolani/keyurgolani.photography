import type { Metadata } from 'next';
import React from 'react';
import DynamicGallery from '../../components/DynamicGallery';
import SiteNav from '../../components/site/SiteNav';

export const metadata: Metadata = { title: 'Gallery' };

export default function GalleryPage() {
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
