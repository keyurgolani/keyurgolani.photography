'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export default function LineDrawingBlindsLoader() {
    const [isLoading, setIsLoading] = useState(true);
    const [showDrawing, setShowDrawing] = useState(false);
    const blinds = 5;

    useEffect(() => {
        const drawingTimer = setTimeout(() => setShowDrawing(true), 100);
        const timer = setTimeout(() => setIsLoading(false), 3000);
        return () => {
            clearTimeout(drawingTimer);
            clearTimeout(timer);
        };
    }, []);

    return (
        <AnimatePresence>
            {isLoading && (
                <motion.div
                    className="absolute inset-0 z-50 flex"
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.5 }}
                >
                    {Array.from({ length: blinds }).map((_, i) => (
                        <motion.div
                            key={i}
                            className="flex-1 bg-gray-900 relative overflow-hidden flex items-center justify-center"
                            initial={{ x: 0 }}
                            exit={{ 
                                x: i % 2 === 0 ? '-100%' : '100%',
                                opacity: 0
                            }}
                            transition={{ 
                                duration: 0.8, 
                                delay: i * 0.1,
                                ease: [0.4, 0, 0.2, 1]
                            }}
                        >
                            <div className="absolute inset-0 bg-gradient-to-b from-white/5 to-transparent" />
                            
                            {/* Line drawing inside each blind */}
                            {showDrawing && (
                                <svg viewBox="0 0 60 60" className="w-16 h-16 opacity-40">
                                    <motion.path
                                        d="M10 25 L10 50 L50 50 L50 25 L40 25 L35 15 L25 15 L20 25 Z"
                                        fill="none"
                                        stroke="white"
                                        strokeWidth="1.5"
                                        initial={{ pathLength: 0 }}
                                        animate={{ pathLength: 1 }}
                                        transition={{ duration: 1.5, delay: i * 0.15, ease: 'easeInOut' }}
                                    />
                                    <motion.circle
                                        cx="30"
                                        cy="35"
                                        r="8"
                                        fill="none"
                                        stroke="white"
                                        strokeWidth="1"
                                        initial={{ pathLength: 0 }}
                                        animate={{ pathLength: 1 }}
                                        transition={{ duration: 0.8, delay: 0.5 + i * 0.15, ease: 'easeInOut' }}
                                    />
                                </svg>
                            )}
                        </motion.div>
                    ))}
                </motion.div>
            )}
        </AnimatePresence>
    );
}