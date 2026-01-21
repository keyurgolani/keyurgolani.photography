'use client';

import React, { useState } from 'react';
import BottomBar from '../../components/BottomBar';

interface ContactFormData {
    name: string;
    email: string;
    message: string;
}

export default function Contact() {
    const [formData, setFormData] = useState<ContactFormData>({
        name: '',
        email: '',
        message: ''
    });

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        console.log('Form submitted:', formData);
        alert('Message sent! (Simulation)');
        setFormData({ name: '', email: '', message: '' });
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const {name, value} = e.target;
        setFormData(prev => ({
            ...prev,
            [name]: value
        }));
    };

    return (
        <main className="min-h-screen bg-background text-primary flex items-center justify-center p-4 pb-40">
            <div className="w-full max-w-lg p-8 rounded-2xl bg-white/60 dark:bg-black/60 backdrop-blur-xl border border-white/40 dark:border-white/10 shadow-2xl animate-fade-in-up transition-colors duration-500">
                <h2 className="text-3xl font-bold mb-8 text-center font-primary tracking-tight">Get in Touch</h2>
                <form onSubmit={handleSubmit} className="space-y-6">
                    <div className="relative group">
                        <input
                            type="text"
                            id="name"
                            name="name"
                            value={formData.name}
                            onChange={handleChange}
                            required
                            className="w-full bg-white/30 dark:bg-white/5 border-none rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all peer placeholder-transparent backdrop-blur-sm"
                            placeholder="Name"
                        />
                        <label 
                            htmlFor="name" 
                            className="absolute left-4 -top-3.5 text-sm text-primary/60 transition-all peer-placeholder-shown:text-base peer-placeholder-shown:top-3 peer-placeholder-shown:left-4 peer-focus:-top-3.5 peer-focus:left-4 peer-focus:text-sm peer-focus:text-primary z-10 bg-transparent"
                        >
                            Name
                        </label>
                    </div>
                    
                    <div className="relative group">
                        <input
                            type="email"
                            id="email"
                            name="email"
                            value={formData.email}
                            onChange={handleChange}
                            required
                            className="w-full bg-white/30 dark:bg-white/5 border-none rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all peer placeholder-transparent backdrop-blur-sm"
                            placeholder="Email"
                        />
                        <label 
                            htmlFor="email" 
                            className="absolute left-4 -top-3.5 text-sm text-primary/60 transition-all peer-placeholder-shown:text-base peer-placeholder-shown:top-3 peer-placeholder-shown:left-4 peer-focus:-top-3.5 peer-focus:left-4 peer-focus:text-sm peer-focus:text-primary z-10 bg-transparent"
                        >
                            Email
                        </label>
                    </div>

                    <div className="relative group">
                        <textarea
                            id="message"
                            name="message"
                            value={formData.message}
                            onChange={handleChange}
                            required
                            rows={4}
                            className="w-full bg-white/30 dark:bg-white/5 border-none rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all peer placeholder-transparent resize-none backdrop-blur-sm"
                            placeholder="Message"
                        />
                         <label 
                            htmlFor="message" 
                            className="absolute left-4 -top-3.5 text-sm text-primary/60 transition-all peer-placeholder-shown:text-base peer-placeholder-shown:top-3 peer-placeholder-shown:left-4 peer-focus:-top-3.5 peer-focus:left-4 peer-focus:text-sm peer-focus:text-primary z-10 bg-transparent"
                        >
                            Message
                        </label>
                    </div>

                    <button 
                        type="submit"
                        className="w-full py-3 px-6 bg-primary text-background font-semibold rounded-lg hover:opacity-90 transition-all transform hover:scale-[1.02] active:scale-95 shadow-lg"
                    >
                        Send Message
                    </button>
                </form>
            </div>
            
            <BottomBar />
        </main>
    );
}
