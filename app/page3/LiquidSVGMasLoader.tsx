'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export default function LiquidSVGMasLoader() {
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
                    <svg viewBox="0 0 200 200" className="w-96 h-96">
                        <defs>
                            <linearGradient id="blobGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                                <stop offset="0%" stopColor="#667eea" />
                                <stop offset="100%" stopColor="#764ba2" />
                            </linearGradient>
                        </defs>
                        
                        {/* Animated blob shapes */}
                        <motion.ellipse
                            cx="100"
                            cy="100"
                            rx="70"
                            ry="70"
                            fill="url(#blobGradient)"
                            initial={{ scale: 0 }}
                            animate={{ scale: [0, 1.5, 1.2, 1] }}
                            exit={{ scale: 0 }}
                            transition={{ duration: 2, ease: 'easeInOut' }}
                            style={{ filter: 'blur(2px)', transformOrigin: 'center' }}
                        />
                        
                        {/* Inner glow */}
                        <motion.ellipse
                            cx="100"
                            cy="100"
                            rx="50"
                            ry="50"
                            fill="#fff"
                            opacity={0.3}
                            initial={{ scale: 0 }}
                            animate={{ scale: [0, 1.3, 1.1, 1] }}
                            transition={{ duration: 2, ease: 'easeInOut' }}
                            style={{ transformOrigin: 'center' }}
                        />
                    </svg>
                    
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 1 }}
                        className="absolute text-white text-lg font-light tracking-[0.2em]"
                    >
                        REVEALING
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}