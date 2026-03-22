'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import DynamicHeroCarousel from '../components/DynamicHeroCarousel';
import RevealingContents from '../components/RevealingContents';
import BottomBar from '../components/BottomBar';
import HeroReveal from '../components/HeroReveal';
import {
    hasCompletedHomeHeroIntro,
    markHomeHeroIntroCompleted,
} from '../utils/homeHeroCache';

export default function Home() {
    const hasCompletedIntro = hasCompletedHomeHeroIntro();
    const [isLoading, setIsLoading] = useState(!hasCompletedIntro);
    const [isSettled, setIsSettled] = useState(hasCompletedIntro);
    const [carouselAutoScroll, setCarouselAutoScroll] = useState(hasCompletedIntro);
    const hasLoadedRef = useRef(hasCompletedIntro);

    const handleFirstImageLoaded = useCallback(() => {
        if (!hasLoadedRef.current) {
            hasLoadedRef.current = true;
            markHomeHeroIntroCompleted();
            setIsLoading(false);
        }
    }, []);

    const handleSettled = useCallback(() => {
        setIsSettled(true);
    }, []);

    // After settle, wait 2.5s then enable carousel auto-scroll
    // Also trigger RevealingContents visibility so BottomBar slide-up is visible
    useEffect(() => {
        if (!isSettled) return;

        // Dispatch a synthetic click to trigger RevealingContents' activity handler,
        // making it visible for its auto-hide timeout period
        window.dispatchEvent(new MouseEvent('click'));

        if (carouselAutoScroll) {
            return;
        }

        const timer = setTimeout(() => setCarouselAutoScroll(true), 2500);
        return () => clearTimeout(timer);
    }, [carouselAutoScroll, isSettled]);

    return (
        <main className="relative w-full h-screen bg-black overflow-hidden">
            {/* HeroReveal — grain overlay, ripples, profile photo animation */}
            <HeroReveal isLoading={isLoading} onSettled={handleSettled} />

            {/* Full Screen Carousel as background/hero */}
            <div className="absolute inset-0 z-0">
                <DynamicHeroCarousel
                    onFirstImageLoaded={handleFirstImageLoaded}
                    autoScrollEnabled={carouselAutoScroll}
                />
            </div>

            {/* Revealing Content Overlay - Controls visibility of children */}
            <RevealingContents>
                <div className="flex flex-col items-center justify-end h-full pb-8">
                    <BottomBar visible={isSettled} />
                </div>
            </RevealingContents>
        </main>
    );
}
