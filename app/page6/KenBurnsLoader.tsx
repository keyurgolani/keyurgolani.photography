'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export default function KenBurnsLoader() {
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
                    {/* Abstract geometric shapes with Ken Burns effect */}
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
                        {/* Gradient background */}
                        <div className="absolute inset-0 bg-gradient-to-br from-gray-900 via-gray-800 to-black" />
                        
                        {/* Abstract shapes */}
                        <motion.div
                            className="absolute top-1/4 left-1/4 w-96 h-96 bg-white/5 rounded-full blur-3xl"
                            animate={{ 
                                scale: [1, 1.3, 1],
                                x: [0, 50, 0],
                                y: [0, -30, 0]
                            }}
                            transition={{ duration: 4, repeat: Infinity }}
                        />
                        <motion.div
                            className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-white/5 rounded-full blur-3xl"
                            animate={{ 
                                scale: [1.2, 1, 1.4],
                                x: [0, -40, 0],
                                y: [0, 40, 0]
                            }}
                            transition={{ duration: 3.5, repeat: Infinity }}
                        />
                        
                        {/* Grid pattern */}
                        <div 
                            className="absolute inset-0 opacity-10"
                            style={{
                                backgroundImage: 'linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)',
                                backgroundSize: '50px 50px'
                            }}
                        />
                    </motion.div>
                    
                    {/* Center text */}
                    <div className="absolute inset-0 flex items-center justify-center">
                        <motion.div
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ delay: 0.3 }}
                            className="text-white/50 text-sm tracking-[0.5em] font-light"
                        >
                            LOADING
                        </motion.div>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}