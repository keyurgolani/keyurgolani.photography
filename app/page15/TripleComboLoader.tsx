'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const phrases = ['Capturing moments', 'That last forever'];
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export default function TripleComboLoader() {
    const [isLoading, setIsLoading] = useState(true);
    const [displayText, setDisplayText] = useState('');
    const [currentPhraseIndex, setCurrentPhraseIndex] = useState(0);

    useEffect(() => {
        const targetText = phrases[currentPhraseIndex % phrases.length];
        let iteration = 0;
        
        const interval = setInterval(() => {
            setDisplayText(
                targetText
                    .split('')
                    .map((char, index) => {
                        if (index < iteration) return char;
                        if (char === ' ') return ' ';
                        return chars[Math.floor(Math.random() * chars.length)];
                    })
                    .join('')
            );
            
            if (iteration >= targetText.length) {
                clearInterval(interval);
                setTimeout(() => setCurrentPhraseIndex((prev) => prev + 1), 800);
            }
            iteration += 1;
        }, 50);

        const timer = setTimeout(() => setIsLoading(false), 3500);

        return () => {
            clearInterval(interval);
            clearTimeout(timer);
        };
    }, [currentPhraseIndex]);

    return (
        <AnimatePresence>
            {isLoading && (
                <motion.div
                    initial={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.8 }}
                    className="absolute inset-0 z-50 bg-black overflow-hidden"
                >
                    {/* Ken Burns background */}
                    <motion.div
                        className="absolute inset-0"
                        initial={{ scale: 1, x: 0, y: 0 }}
                        animate={{ 
                            scale: [1, 1.15, 1.1, 1.2],
                            x: [0, -30, 20, -10],
                            y: [0, 20, -15, 5]
                        }}
                        transition={{ duration: 3.5, ease: 'easeInOut' }}
                    >
                        <div className="absolute inset-0 bg-gradient-to-br from-gray-900 via-gray-800 to-black" />
                        <motion.div
                            className="absolute top-1/3 left-1/3 w-80 h-80 bg-white/5 rounded-full blur-3xl"
                            animate={{ scale: [1, 1.2, 1], x: [0, 30, 0], y: [0, -20, 0] }}
                            transition={{ duration: 3, repeat: Infinity }}
                        />
                        <motion.div
                            className="absolute bottom-1/3 right-1/3 w-64 h-64 bg-white/5 rounded-full blur-3xl"
                            animate={{ scale: [1.1, 1, 1.3], x: [0, -25, 0], y: [0, 25, 0] }}
                            transition={{ duration: 2.5, repeat: Infinity }}
                        />
                    </motion.div>

                    {/* Line Drawing camera icon - upper center */}
                    <motion.div
                        className="absolute top-1/3 left-1/2 -translate-x-1/2"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.3 }}
                    >
                        <svg viewBox="0 0 200 200" className="w-48 h-48">
                            <motion.path
                                d="M30 70 L30 150 L170 150 L170 70 L140 70 L130 50 L70 50 L60 70 Z"
                                fill="none"
                                stroke="rgba(255,255,255,0.5)"
                                strokeWidth="2"
                                strokeLinecap="round"
                                initial={{ pathLength: 0 }}
                                animate={{ pathLength: 1 }}
                                transition={{ duration: 1.5, delay: 0.2, ease: 'easeInOut' }}
                            />
                            <motion.circle
                                cx="100"
                                cy="100"
                                r="25"
                                fill="none"
                                stroke="rgba(255,255,255,0.5)"
                                strokeWidth="2"
                                initial={{ pathLength: 0 }}
                                animate={{ pathLength: 1 }}
                                transition={{ duration: 1, delay: 0.8, ease: 'easeInOut' }}
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
                                transition={{ duration: 0.8, delay: 1.1, ease: 'easeInOut' }}
                            />
                        </svg>
                    </motion.div>

                    {/* Text scramble - bottom center */}
                    <motion.div
                        className="absolute bottom-1/3 left-1/2 -translate-x-1/2"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 1 }}
                    >
                        <motion.p
                            key={displayText}
                            initial={{ opacity: 0.7 }}
                            animate={{ opacity: 1 }}
                            className="text-white/80 text-xl md:text-2xl font-light tracking-[0.15em] font-mono text-center"
                        >
                            {displayText}
                        </motion.p>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}