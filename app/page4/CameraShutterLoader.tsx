'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export default function CameraShutterLoader() {
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const timer = setTimeout(() => setIsLoading(false), 3000);
        return () => clearTimeout(timer);
    }, []);

    const blades = 8;
    const bladeAngle = 360 / blades;

    return (
        <AnimatePresence>
            {isLoading && (
                <motion.div
                    initial={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.5 }}
                    className="absolute inset-0 z-50 bg-black flex items-center justify-center"
                >
                    <div className="relative w-64 h-64">
                        {/* Outer ring */}
                        <motion.div
                            className="absolute inset-0 border-4 border-white/30 rounded-full"
                            animate={{ rotate: 360 }}
                            transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
                        />
                        
                        {/* Shutter blades */}
                        {Array.from({ length: blades }).map((_, i) => (
                            <motion.div
                                key={i}
                                className="absolute inset-0"
                                style={{
                                    transform: `rotate(${i * bladeAngle}deg)`,
                                    transformOrigin: 'center center',
                                }}
                            >
                                <motion.div
                                    className="absolute top-1/2 left-1/2 w-1/2 h-full"
                                    style={{
                                        transformOrigin: 'left center',
                                        background: `linear-gradient(90deg, rgba(255,255,255,0.1), rgba(255,255,255,0.3))`,
                                    }}
                                    initial={{ scaleX: 1 }}
                                    animate={{ scaleX: [1, 0, 1] }}
                                    transition={{
                                        duration: 2,
                                        repeat: Infinity,
                                        ease: 'easeInOut',
                                        delay: i * 0.05,
                                    }}
                                />
                            </motion.div>
                        ))}
                        
                        {/* Center circle */}
                        <motion.div
                            className="absolute inset-1/4 bg-white/20 rounded-full"
                            animate={{ scale: [1, 0.8, 1] }}
                            transition={{ duration: 1, repeat: Infinity }}
                        />
                        
                        {/* Center dot */}
                        <div className="absolute inset-0 flex items-center justify-center">
                            <motion.div
                                className="w-4 h-4 bg-white rounded-full"
                                animate={{ opacity: [0.5, 1, 0.5] }}
                                transition={{ duration: 1.5, repeat: Infinity }}
                            />
                        </div>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}