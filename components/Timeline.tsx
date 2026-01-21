'use client';

import React from 'react';

// Using a more dynamic approach or keeping the static content if it rarely changes.
// For now, hardcoding to match the original but with better styling.

export default function Timeline() {
  const events = [
    {
       title: "Meta (Facebook)",
       role: "Senior Software Engineer",
       year: "2021 - Present",
       desc: "Building scalable solutions for billions of users",
       type: "work"
    },
    {
       title: "Photography Achievement",
       role: "20,000+ Instagram Followers",
       year: "2022",
       desc: "",
       type: "photo"
    },
    {
       title: "Amazon",
       role: "Software Development Engineer",
       year: "2019 - 2021",
       desc: "AWS infrastructure and cloud computing",
       type: "work"
    },
    {
        title: "500px Feature",
        role: "Featured Photographer",
        year: "2020",
        desc: "",
        type: "photo"
     },
     {
        title: "Pure Storage",
        role: "Systems Engineer",
        year: "2017 - 2019",
        desc: "Enterprise storage solutions",
        type: "work"
     },
     {
        title: "Photography Journey Begins",
        role: "Started landscape and street photography",
        year: "2017",
        desc: "",
        type: "photo"
     }
  ];

  return (
    <div className="relative py-10 w-full max-w-2xl mx-auto">
        {/* Central Line */}
        <div className="absolute left-1/2 transform -translate-x-1/2 w-0.5 h-full bg-gradient-to-b from-transparent via-primary/30 to-transparent" />

        {events.map((event, index) => (
            <div key={index} className={`relative flex items-center justify-between mb-12 w-full ${index % 2 === 0 ? 'flex-row-reverse' : ''}`}>
                {/* Content */}
                <div className={`w-5/12 ${index % 2 === 0 ? 'text-left pl-8' : 'text-right pr-8'} group`}>
                    <div className="mb-1 text-primary/50 font-mono text-sm">{event.year}</div>
                    <h3 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-primary to-primary/60">{event.title}</h3>
                    <p className="text-sm font-semibold text-primary/80 mt-1">{event.role}</p>
                    {event.desc && <p className="text-xs text-primary/60 mt-2 leading-relaxed">{event.desc}</p>}
                </div>

                {/* Dot */}
                <div className="absolute left-1/2 transform -translate-x-1/2 w-4 h-4 rounded-full bg-background border-2 border-primary group-hover:scale-125 transition-transform duration-300 z-10 shadow-[0_0_10px_rgba(var(--primary-color-rgb),0.3)]">
                     <div className={`w-full h-full rounded-full opacity-0 transition-opacity duration-300 ${event.type === 'photo' ? 'bg-indigo-500' : 'bg-primary'}`} />
                </div>
                
                {/* Spacer */}
                <div className="w-5/12" />
            </div>
        ))}
    </div>
  );
}
