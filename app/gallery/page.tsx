import React from 'react';
import BottomBar from '../../components/BottomBar';
import DynamicGallery from '../../components/DynamicGallery';

export default function GalleryPage() {
    return (
        <>
            {/* Fixed, so leading the DOM puts the navigation first in Tab order without moving it. Outside main, so the nav landmark isn't part of the page's content. */}
            <BottomBar />
            <main className="min-h-screen bg-background pb-40">
                <div className="w-full max-w-[2000px] mx-auto px-4 sm:px-6 lg:px-8 pt-8">
                    <h1 className="text-4xl font-bold text-center mb-10 font-primary">Gallery</h1>
                    <DynamicGallery />
                </div>
            </main>
        </>
    );
}
