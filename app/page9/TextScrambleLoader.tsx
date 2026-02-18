'use client';

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const phrases = [
    'Photography is the story I fail to put into words',
    'Capturing moments that last forever',
    'Every picture tells a story'
];

const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';

export default function TextScrambleLoader() {
    const [isLoading, setIsLoading] = useState(true);
    const [displayText, setDisplayText] = useState('');
    const [currentPhraseIndex, setCurrentPhraseIndex] = useState(0);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const targetText = phrases[currentPhraseIndex];
        let iteration = 0;
        let frame = 0;
        
        const interval = setInterval(() => {
            setDisplayText(
                targetText
                    .split('')
                    .map((char, index) => {
                        if (index < iteration) {
                            return char;
                        }
                        if (char === ' ') return ' ';
                        return chars[Math.floor(Math.random() * chars.length)];
                    })
                    .join('')
            );
            
            if (iteration >= targetText.length) {
                clearInterval(interval);
                setTimeout(() => {
                    setCurrentPhraseIndex((prev) => (prev + 1) % phrases.length);
                }, 1000);
            }
            
            frame++;
            if (frame % 3 === 0) {
                iteration += 1;
            }
        }, 30);

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
                    ref={containerRef}
                    initial={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.5 }}
                    className="absolute inset-0 z-50 bg-black flex items-center justify-center"
                >
                    <div className="text-center px-8">
                        <motion.p
                            key={displayText}
                            initial={{ opacity: 0.7 }}
                            animate={{ opacity: 1 }}
                            className="text-white/80 text-lg md:text-xl font-light tracking-wide font-mono"
                        >
                            {displayText}
                        </motion.p>
                        
                        <motion.div
                            className="mt-8 flex justify-center gap-1"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ delay: 0.5 }}
                        >
                            {[0, 1, 2].map((i) => (
                                <motion.div
                                    key={i}
                                    className="w-1 h-1 bg-white/50 rounded-full"
                                    animate={{ opacity: i === currentPhraseIndex ? 1 : 0.3 }}
                                />
                            ))}
                        </motion.div>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}