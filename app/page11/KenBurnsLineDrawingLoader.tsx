'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export default function KenBurnsLineDrawingLoader() {
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
                    transition={{ duration: 0.8 }}
                    className="absolute inset-0 z-50 bg-black overflow-hidden"
                >
                    {/* Ken Burns background layer */}
                    <motion.div
                        className="absolute inset-0"
                        initial={{ scale: 1, x: 0, y: 0 }}
                        animate={{ 
                            scale: [1, 1.2, 1.1, 1.3],
                            x: [0, -50, 30, -20],
                            y: [0, 30, -20, 10]
                        }}
                        transition={{ duration: 3, ease: 'easeInOut' }}
                    >
                        <div className="absolute inset-0 bg-gradient-to-br from-gray-900 via-gray-800 to-black" />
                        <motion.div
                            className="absolute top-1/4 left-1/4 w-96 h-96 bg-white/5 rounded-full blur-3xl"
                            animate={{ scale: [1, 1.3, 1], x: [0, 50, 0], y: [0, -30, 0] }}
                            transition={{ duration: 4, repeat: Infinity }}
                        />
                        <motion.div
                            className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-white/5 rounded-full blur-3xl"
                            animate={{ scale: [1.2, 1, 1.4], x: [0, -40, 0], y: [0, 40, 0] }}
                            transition={{ duration: 3.5, repeat: Infinity }}
                        />
                    </motion.div>

                    {/* Line Drawing camera in center */}
                    <motion.div
                        className="absolute inset-0 flex items-center justify-center"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.5 }}
                    >
                        <svg viewBox="0 0 200 200" className="w-64 h-64">
                            <motion.path
                                d="M30 70 L30 150 L170 150 L170 70 L140 70 L130 50 L70 50 L60 70 Z"
                                fill="none"
                                stroke="rgba(255,255,255,0.6)"
                                strokeWidth="2"
                                strokeLinecap="round"
                                initial={{ pathLength: 0 }}
                                animate={{ pathLength: 1 }}
                                transition={{ duration: 1.5, ease: 'easeInOut' }}
                            />
                            <motion.circle
                                cx="100"
                                cy="100"
                                r="25"
                                fill="none"
                                stroke="rgba(255,255,255,0.6)"
                                strokeWidth="2"
                                initial={{ pathLength: 0 }}
                                animate={{ pathLength: 1 }}
                                transition={{ duration: 1, delay: 0.5, ease: 'easeInOut' }}
                            />
                            <motion.circle
                                cx="100"
                                cy="100"
                                r="15"
                                fill="none"
                                stroke="rgba(255,255,255,0.3)"
                                strokeWidth="1"
                                initial={{ pathLength: 0 }}
                                animate={{ pathLength: 1 }}
                                transition={{ duration: 0.8, delay: 0.8, ease: 'easeInOut' }}
                            />
                        </svg>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}