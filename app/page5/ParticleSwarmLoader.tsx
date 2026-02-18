'use client';

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export default function ParticleSwarmLoader() {
    const [isLoading, setIsLoading] = useState(true);
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        interface Particle {
            x: number;
            y: number;
            targetX: number;
            targetY: number;
            size: number;
            color: string;
            speed: number;
        }

        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;
        const particles: Particle[] = [];
        const particleCount = 200;
        const colors = ['#60a5fa', '#a78bfa', '#f472b6', '#34d399', '#fbbf24'];

        for (let i = 0; i < particleCount; i++) {
            const angle = Math.random() * Math.PI * 2;
            const radius = Math.random() * 300 + 100;
            particles.push({
                x: centerX + Math.cos(angle) * radius,
                y: centerY + Math.sin(angle) * radius,
                targetX: centerX + (Math.random() - 0.5) * 100,
                targetY: centerY + (Math.random() - 0.5) * 100,
                size: Math.random() * 3 + 1,
                color: colors[Math.floor(Math.random() * colors.length)],
                speed: Math.random() * 0.02 + 0.01,
            });
        }

        let animationId: number;
        let time = 0;

        const animate = () => {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            time += 0.01;

            particles.forEach(p => {
                p.x += (p.targetX - p.x) * p.speed;
                p.y += (p.targetY - p.y) * p.speed;

                // Add some floating motion
                p.targetX = centerX + Math.sin(time + particles.indexOf(p)) * 50;
                p.targetY = centerY + Math.cos(time + particles.indexOf(p)) * 50;

                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                ctx.fillStyle = p.color;
                ctx.fill();

                // Glow effect
                ctx.shadowBlur = 10;
                ctx.shadowColor = p.color;
            });

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