'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export default function SplitBlindsLoader() {
    const [isLoading, setIsLoading] = useState(true);
    const blinds = 5;

    useEffect(() => {
        const timer = setTimeout(() => setIsLoading(false), 3000);
        return () => clearTimeout(timer);
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
                            className="flex-1 bg-gray-900 relative overflow-hidden"
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
                            {/* Subtle gradient on each blind */}
                            <div className="absolute inset-0 bg-gradient-to-b from-white/5 to-transparent" />
                            
                            {/* Animated line */}
                            <motion.div
                                className="absolute top-1/2 left-0 right-0 h-px bg-white/20"
                                animate={{ scaleX: [0, 1, 0], x: ['-50%', '0%', '50%'] }}
                                transition={{ duration: 2, repeat: Infinity, delay: i * 0.2 }}
                            />
                        </motion.div>
                    ))}
                    
                    {/* Center logo/text */}
                    <motion.div
                        className="absolute inset-0 flex items-center justify-center"
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.3 }}
                    >
                        <motion.div
                            animate={{ opacity: [0.5, 1, 0.5] }}
                            transition={{ duration: 1.5, repeat: Infinity }}
                            className="text-white/80 text-xl tracking-[0.3em] font-light"
                        >
                            KG
                        </motion.div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}