import React from 'react';
import { getGalleryImages } from '../../utils/getImageData';
import BottomBar from '../../components/BottomBar';
import Gallery from '../../components/Gallery';

export default async function GalleryPage() {
  const galleryImages = await getGalleryImages();
  
  const images = galleryImages.map((img, index) => ({
    id: index,
    src: img.src,
    width: img.width,
    height: img.height,
    caption: img.caption || undefined
  }));

  return (
    <main className="min-h-screen bg-background pb-40">
       <div className="w-full max-w-[2000px] mx-auto px-4 sm:px-6lg:px-8 pt-8">
            <h1 className="text-4xl font-bold text-center mb-10 font-primary">Gallery</h1>
            
            {images.length > 0 ? (
                <Gallery images={images} />
            ) : (
                <div className="space-y-8">
                    {/* No photos message */}
                    <div className="text-center text-primary/60 py-8">
                        <p>No images found in the gallery.</p>
                    </div>
                    
                    {/* Skeleton grid */}
                    <div className="grid grid-cols-4 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12 auto-rows-[50px] gap-3 grid-flow-dense">
                        {/* Skeleton items with varying sizes to mimic real gallery */}
                        <div className="col-span-4 row-span-5 bg-white/10 rounded-xl animate-pulse" />
                        <div className="col-span-4 row-span-4 bg-white/10 rounded-xl animate-pulse" />
                        <div className="col-span-4 row-span-6 bg-white/10 rounded-xl animate-pulse" />
                        <div className="col-span-4 row-span-4 bg-white/10 rounded-xl animate-pulse" />
                        <div className="col-span-4 row-span-5 bg-white/10 rounded-xl animate-pulse" />
                        <div className="col-span-4 row-span-4 bg-white/10 rounded-xl animate-pulse" />
                        <div className="col-span-4 row-span-6 bg-white/10 rounded-xl animate-pulse" />
                        <div className="col-span-4 row-span-5 bg-white/10 rounded-xl animate-pulse" />
                        <div className="col-span-4 row-span-4 bg-white/10 rounded-xl animate-pulse" />
                    </div>
                </div>
            )}
       </div>
       <BottomBar />
    </main>
  );
}
