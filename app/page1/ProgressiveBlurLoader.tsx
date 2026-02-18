'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export default function ProgressiveBlurLoader() {
    const [isLoading, setIsLoading] = useState(true);
    const [blurLevel, setBlurLevel] = useState(30);

    useEffect(() => {
        // Gradually reduce blur over 2 seconds
        const blurInterval = setInterval(() => {
            setBlurLevel(prev => Math.max(0, prev - 2));
        }, 67); // ~30 steps over 2 seconds

        const timer = setTimeout(() => {
            setIsLoading(false);
        }, 2500);

        return () => {
            clearTimeout(timer);
            clearInterval(blurInterval);
        };
    }, []);

    return (
        <AnimatePresence>
            {isLoading && (
                <motion.div
                    initial={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.5 }}
                    className="absolute inset-0 z-50 flex items-center justify-center bg-black"
                    style={{
                        backdropFilter: `blur(${blurLevel}px)`,
                        WebkitBackdropFilter: `blur(${blurLevel}px)`,
                    }}
                >
                    <motion.div
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ duration: 0.5 }}
                        className="text-white text-2xl font-light tracking-widest"
                    >
                        <motion.div
                            animate={{ opacity: [0.5, 1, 0.5] }}
                            transition={{ duration: 1.5, repeat: Infinity }}
                            className="flex items-center gap-3"
                        >
                            <div className="w-2 h-2 bg-white rounded-full" />
                            <span>Loading</span>
                        </motion.div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}