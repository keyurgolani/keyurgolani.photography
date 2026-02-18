'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const phrases = ['Photography is the story', 'I fail to put into words'];
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export default function KenBurnsTextScrambleLoader() {
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

                    {/* Text scramble overlay */}
                    <motion.div
                        className="absolute inset-0 flex items-center justify-center"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.3 }}
                    >
                        <motion.p
                            key={displayText}
                            initial={{ opacity: 0.7 }}
                            animate={{ opacity: 1 }}
                            className="text-white/80 text-2xl md:text-3xl font-light tracking-[0.2em] font-mono text-center px-8"
                        >
                            {displayText}
                        </motion.p>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}