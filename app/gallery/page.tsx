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
                <div className="text-center text-primary/60 py-20">
                    <p>No images found in the gallery.</p>
                </div>
            )}
       </div>
       <BottomBar />
    </main>
  );
}
