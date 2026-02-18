'use client';

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export default function FilmBurnLoader() {
    const [isLoading, setIsLoading] = useState(true);
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        interface LightLeak {
            x: number;
            y: number;
            radius: number;
            color: string;
            speed: number;
            angle: number;
        }

        const lightLeaks: LightLeak[] = [];
        const colors = [
            'rgba(255, 100, 50, 0.3)',
            'rgba(255, 200, 100, 0.3)',
            'rgba(255, 150, 50, 0.2)',
            'rgba(255, 50, 100, 0.2)',
        ];

        for (let i = 0; i < 5; i++) {
            lightLeaks.push({
                x: Math.random() * canvas.width,
                y: Math.random() * canvas.height,
                radius: Math.random() * 300 + 100,
                color: colors[Math.floor(Math.random() * colors.length)],
                speed: Math.random() * 2 + 1,
                angle: Math.random() * Math.PI * 2,
            });
        }

        // Film grain particles
        const grainParticles: { x: number; y: number; opacity: number }[] = [];
        for (let i = 0; i < 1000; i++) {
            grainParticles.push({
                x: Math.random() * canvas.width,
                y: Math.random() * canvas.height,
                opacity: Math.random() * 0.3,
            });
        }

        let animationId: number;
        let time = 0;

        const animate = () => {
            // Dark background with slight flicker
            const flicker = 0.9 + Math.random() * 0.1;
            ctx.fillStyle = `rgba(0, 0, 0, ${flicker})`;
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            time += 0.02;

            // Draw light leaks
            lightLeaks.forEach((leak, index) => {
                leak.x += Math.cos(leak.angle) * leak.speed;
                leak.y += Math.sin(leak.angle) * leak.speed;
                leak.angle += (Math.random() - 0.5) * 0.1;

                if (leak.x < -leak.radius) leak.x = canvas.width + leak.radius;
                if (leak.x > canvas.width + leak.radius) leak.x = -leak.radius;
                if (leak.y < -leak.radius) leak.y = canvas.height + leak.radius;
                if (leak.y > canvas.height + leak.radius) leak.y = -leak.radius;

                const gradient = ctx.createRadialGradient(
                    leak.x, leak.y, 0,
                    leak.x, leak.y, leak.radius
                );
                gradient.addColorStop(0, leak.color);
                gradient.addColorStop(1, 'transparent');

                ctx.beginPath();
                ctx.arc(leak.x, leak.y, leak.radius, 0, Math.PI * 2);
                ctx.fillStyle = gradient;
                ctx.fill();
            });

            // Film grain overlay
            grainParticles.forEach(grain => {
                grain.opacity = Math.random() * 0.3;
                ctx.fillStyle = `rgba(255, 255, 255, ${grain.opacity})`;
                ctx.fillRect(grain.x, grain.y, 1, 1);
            });

            // Occasional flash
            if (Math.random() > 0.98) {
                ctx.fillStyle = `rgba(255, 200, 150, ${Math.random() * 0.3})`;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            }

            // Vignette effect
            const vignette = ctx.createRadialGradient(
                canvas.width / 2, canvas.height / 2, 0,
                canvas.width / 2, canvas.height / 2, canvas.width / 1.5
            );
            vignette.addColorStop(0, 'transparent');
            vignette.addColorStop(1, 'rgba(0, 0, 0, 0.5)');
            ctx.fillStyle = vignette;
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            animationId = requestAnimationFrame(animate);
        };

        animate();

        const timer = setTimeout(() => setIsLoading(false), 3000);

        return () => {
            cancelAnimationFrame(animationId);
            clearTimeout(timer);
        };
    }, []);

    return (
        <AnimatePresence>
            {isLoading && (
                <motion.div
                    initial={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.8 }}
                    className="absolute inset-0 z-50"
                >
                    <canvas ref={canvasRef} className="w-full h-full" />
                </motion.div>
            )}
        </AnimatePresence>
    );
}