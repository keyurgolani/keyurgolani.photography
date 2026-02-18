'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const phrases = ['Capturing moments', 'That last forever'];
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';

export default function BlindsTextScrambleLoader() {
    const [isLoading, setIsLoading] = useState(true);
    const [displayText, setDisplayText] = useState('');
    const [currentPhraseIndex, setCurrentPhraseIndex] = useState(0);
    const blinds = 5;

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

        const timer = setTimeout(() => setIsLoading(false), 3000);

        return () => {
            clearInterval(interval);
            clearTimeout(timer);
        };
    }, [currentPhraseIndex]);

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
                            <div className="absolute inset-0 bg-gradient-to-b from-white/5 to-transparent" />
                        </motion.div>
                    ))}
                    
                    {/* Text scramble in center */}
                    <motion.div
                        className="absolute inset-0 flex items-center justify-center"
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.3 }}
                    >
                        <motion.p
                            key={displayText}
                            initial={{ opacity: 0.7 }}
                            animate={{ opacity: 1 }}
                            className="text-white/80 text-2xl font-light tracking-[0.15em] font-mono"
                        >
                            {displayText}
                        </motion.p>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}