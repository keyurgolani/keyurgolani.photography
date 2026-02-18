'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const phrases = ['Capturing moments', 'That last forever'];
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

interface LoadingAnimationProps {
    isLoading: boolean;
}

export default function LoadingAnimation({ isLoading }: LoadingAnimationProps) {
    const [displayText, setDisplayText] = useState('');
    const [currentPhraseIndex, setCurrentPhraseIndex] = useState(0);
    const [showDrawing, setShowDrawing] = useState(false);
    const blinds = 5;

    useEffect(() => {
        const drawingTimer = setTimeout(() => setShowDrawing(true), 100);
        
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

        return () => {
            clearInterval(interval);
            clearTimeout(drawingTimer);
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
                    {/* Layer 1: Ken Burns background */}
                    <motion.div
                        className="absolute inset-0"
                        initial={{ scale: 1, x: 0, y: 0 }}
                        animate={{ 
                            scale: [1, 1.15, 1.1, 1.2],
                            x: [0, -30, 20, -10],
                            y: [0, 20, -15, 5]
                        }}
                        transition={{ duration: 4, ease: 'easeInOut' }}
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

                    {/* Layer 2: Split Blinds with Line Drawing inside each */}
                    <motion.div
                        className="absolute inset-0 flex"
                    >
                        {Array.from({ length: blinds }).map((_, i) => (
                            <motion.div
                                key={i}
                                className="flex-1 bg-gray-900/80 relative overflow-hidden flex items-center justify-center"
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
                                
                                {/* Line drawing camera inside each blind */}
                                {showDrawing && (
                                    <svg viewBox="0 0 60 60" className="w-12 h-12 opacity-50">
                                        <motion.path
                                            d="M10 20 L10 45 L50 45 L50 20 L40 20 L35 10 L25 10 L20 20 Z"
                                            fill="none"
                                            stroke="white"
                                            strokeWidth="1.5"
                                            initial={{ pathLength: 0 }}
                                            animate={{ pathLength: 1 }}
                                            transition={{ duration: 1.2, delay: i * 0.15, ease: 'easeInOut' }}
                                        />
                                        <motion.circle
                                            cx="30"
                                            cy="30"
                                            r="8"
                                            fill="none"
                                            stroke="white"
                                            strokeWidth="1"
                                            initial={{ pathLength: 0 }}
                                            animate={{ pathLength: 1 }}
                                            transition={{ duration: 0.8, delay: 0.4 + i * 0.15, ease: 'easeInOut' }}
                                        />
                                    </svg>
                                )}
                            </motion.div>
                        ))}
                    </motion.div>

                    {/* Layer 3: Central Line Drawing camera icon */}
                    <motion.div
                        className="absolute inset-0 flex items-center justify-center pointer-events-none"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.5 }}
                    >
                        <svg viewBox="0 0 200 200" className="w-48 h-48">
                            <motion.path
                                d="M30 70 L30 150 L170 150 L170 70 L140 70 L130 50 L70 50 L60 70 Z"
                                fill="none"
                                stroke="rgba(255,255,255,0.4)"
                                strokeWidth="2"
                                strokeLinecap="round"
                                initial={{ pathLength: 0 }}
                                animate={{ pathLength: 1 }}
                                transition={{ duration: 1.5, delay: 0.3, ease: 'easeInOut' }}
                            />
                            <motion.circle
                                cx="100"
                                cy="100"
                                r="25"
                                fill="none"
                                stroke="rgba(255,255,255,0.4)"
                                strokeWidth="2"
                                initial={{ pathLength: 0 }}
                                animate={{ pathLength: 1 }}
                                transition={{ duration: 1, delay: 0.9, ease: 'easeInOut' }}
                            />
                            <motion.circle
                                cx="100"
                                cy="100"
                                r="15"
                                fill="none"
                                stroke="rgba(255,255,255,0.2)"
                                strokeWidth="1"
                                initial={{ pathLength: 0 }}
                                animate={{ pathLength: 1 }}
                                transition={{ duration: 0.8, delay: 1.2, ease: 'easeInOut' }}
                            />
                        </svg>
                    </motion.div>

                    {/* Layer 4: Text scramble at bottom */}
                    <motion.div
                        className="absolute bottom-1/4 left-1/2 -translate-x-1/2"
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