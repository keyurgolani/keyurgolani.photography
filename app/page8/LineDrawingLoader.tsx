'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export default function LineDrawingLoader() {
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const timer = setTimeout(() => setIsLoading(false), 3000);
        return () => clearTimeout(timer);
    }, []);

    return (
        <AnimatePresence>
            {isLoading && (
                <motion.div
                    initial={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.5 }}
                    className="absolute inset-0 z-50 bg-black flex items-center justify-center"
                >
                    <svg
                        viewBox="0 0 200 200"
                        className="w-64 h-64"
                    >
                        {/* Camera body outline */}
                        <motion.path
                            d="M30 70 L30 150 L170 150 L170 70 L140 70 L130 50 L70 50 L60 70 Z"
                            fill="none"
                            stroke="white"
                            strokeWidth="2"
                            strokeLinecap="round"
                            initial={{ pathLength: 0 }}
                            animate={{ pathLength: 1 }}
                            transition={{ duration: 2, ease: 'easeInOut' }}
                        />
                        
                        {/* Lens circle */}
                        <motion.circle
                            cx="100"
                            cy="100"
                            r="25"
                            fill="none"
                            stroke="white"
                            strokeWidth="2"
                            initial={{ pathLength: 0 }}
                            animate={{ pathLength: 1 }}
                            transition={{ duration: 1.5, delay: 0.5, ease: 'easeInOut' }}
                        />
                        
                        {/* Inner lens circle */}
                        <motion.circle
                            cx="100"
                            cy="100"
                            r="15"
                            fill="none"
                            stroke="white"
                            strokeWidth="1"
                            strokeOpacity={0.5}
                            initial={{ pathLength: 0 }}
                            animate={{ pathLength: 1 }}
                            transition={{ duration: 1, delay: 1, ease: 'easeInOut' }}
                        />
                        
                        {/* Flash */}
                        <motion.rect
                            x="40"
                            y="55"
                            width="15"
                            height="10"
                            fill="none"
                            stroke="white"
                            strokeWidth="1.5"
                            initial={{ pathLength: 0 }}
                            animate={{ pathLength: 1 }}
                            transition={{ duration: 0.5, delay: 1.5, ease: 'easeInOut' }}
                        />
                        
                        {/* Shutter button */}
                        <motion.rect
                            x="75"
                            y="48"
                            width="50"
                            height="8"
                            fill="none"
                            stroke="white"
                            strokeWidth="1.5"
                            rx="2"
                            initial={{ pathLength: 0 }}
                            animate={{ pathLength: 1 }}
                            transition={{ duration: 0.5, delay: 1.8, ease: 'easeInOut' }}
                        />
                    </svg>
                </motion.div>
            )}
        </AnimatePresence>
    );
}