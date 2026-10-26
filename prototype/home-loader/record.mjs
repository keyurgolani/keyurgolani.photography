// Stage 1 recorder for Home's loader (prototype only, never shipped).
//
//   node prototype/home-loader/record.mjs --url http://127.0.0.1:3375/ --out <dir> \
//     --viewport 1440x900 [--dpr 1] [--mobile] [--mouse] [--photo-delay 800] [--tail 1500]
//
// Loads Home in a fresh context (so the intro plays: first visit, motion on),
// serves /api/photos from one generated background photograph after
// --photo-delay ms, so loading ends before the 2.4 s ripple minimum and the
// exit starts at the same point in every recording. It captures a CDP
// screencast (every compositor frame Chrome hands over, with its swap
// timestamp) and samples the loader's state every animation frame: the
// mask radius, the portrait's opacity, box and transforms. Frames are named
// by their time relative to the reveal start (the first frame the mask
// radius grows), so recordings line up on the handoff.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import sharp from 'sharp';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);
const url = opt('url');
const out = opt('out');
const [vw, vh] = opt('viewport', '1440x900').split('x').map(Number);
const dpr = Number(opt('dpr', '1'));
const mobile = flag('mobile');
const corners = flag('corners');
const mouse = flag('mouse') || corners;
const photoDelay = Number(opt('photo-delay', '800'));
const tail = Number(opt('tail', '1500'));
// Frames come at CSS pixel size, whatever the device pixel ratio.
const maxW = Number(opt('max-width', String(vw)));
const maxH = Number(opt('max-height', String(vh)));
if (!url || !out) throw new Error('usage: record.mjs --url <url> --out <dir> ...');
const host = new URL(url).hostname;
if (host !== '127.0.0.1') throw new Error(`Loopback only, refusing ${host}`);

fs.mkdirSync(path.join(out, 'frames'), { recursive: true });

// One background photograph, a dusk gradient, so the reveal opens onto the same picture everywhere.
const bg = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1200">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a6f8c"/><stop offset="0.55" stop-color="#1b2a55"/><stop offset="1" stop-color="#0b0f24"/></linearGradient></defs>
  <rect width="1800" height="1200" fill="url(#g)"/>
  <circle cx="1350" cy="300" r="120" fill="#f3d9a4" opacity="0.8"/>
  <path d="M0 1000 L400 640 L700 900 L1050 560 L1450 880 L1800 700 L1800 1200 L0 1200 Z" fill="#0a0d18"/>
</svg>`)).jpeg({ quality: 88 }).toBuffer();
const BG_URL = '/assets/photos/rec-bg.jpg';
const records = [{ id: 0, src: BG_URL, thumbnail: BG_URL, medium: BG_URL, optimized: BG_URL, width: 1800, height: 1200, optimizedWidth: 1800, optimizedHeight: 1200, caption: '', date: Date.UTC(2024, 0, 1), lqip: '' }];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
    viewport: { width: vw, height: vh },
    deviceScaleFactor: dpr,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
});
const page = await context.newPage();
await page.route('**/api/photos', async (route) => {
    await new Promise((r) => setTimeout(r, photoDelay));
    await route.fulfill({ json: records });
});
await page.route('**/assets/photos/**', (route) => route.fulfill({ body: bg, contentType: 'image/jpeg' }));
await page.route('**/_next/image**', async (route) => {
    const source = new URL(new URL(route.request().url()).searchParams.get('url') ?? '', 'http://x');
    if (source.pathname.startsWith('/assets/photos/')) return route.fulfill({ body: bg, contentType: 'image/jpeg' });
    return route.continue();
});
// Nothing leaves loopback.
await page.route((u) => u.hostname !== '127.0.0.1', (route) => route.abort());

await page.addInitScript(() => {
    const rec = { start: Date.now(), samples: [], marks: {} };
    window.__rec = rec;
    const maskEl = () => [...document.querySelectorAll('div')].find((d) => /radial-gradient\(/.test(d.style.maskImage || d.style.webkitMaskImage || ''));
    // The loader portrait: the old Home's two layers, or the prototype's single image.
    const portraitImg = () => document.querySelector('img[alt="Profile Front"]') || document.querySelector('[data-loader-portrait] img');
    const fixedAncestor = (el) => {
        for (let n = el; n; n = n.parentElement) if (getComputedStyle(n).position === 'fixed') return n;
        return null;
    };
    const effOpacity = (el) => {
        let o = 1;
        for (let n = el; n; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity);
        return o;
    };
    const tick = () => {
        const t = Date.now();
        const m = maskEl();
        const img = portraitImg();
        const s = { t };
        if (m) {
            const g = (m.style.maskImage || m.style.webkitMaskImage).match(/radial-gradient\((?:circle )?([\d.]+)px/);
            s.mask = g ? Number(g[1]) : null;
        }
        if (img) {
            const box = fixedAncestor(img);
            const r = img.getBoundingClientRect();
            s.img = [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10);
            s.opacity = Math.round(effOpacity(img) * 1000) / 1000;
            if (box) {
                const b = box.getBoundingClientRect();
                s.box = [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 10) / 10);
                s.boxTransform = getComputedStyle(box).transform;
            }
            // img, its frame, the layer, the card; the prototype's img sits in a <picture> too.
            const up = (n, k) => { for (let i = 0; i < k && n; i++) n = n.parentElement; return n; };
            const card = img.closest('[data-loader-portrait]') ? up(img, 4) : up(img, 3);
            s.shadow = getComputedStyle(img).boxShadow;
            if (card) s.card = card.style.transform || '';
            const layers = card ? [...card.children].map((l) => l.style.transform || '') : [];
            if (layers.length) s.layers = layers;
            const all = [...document.querySelectorAll('img[alt^="Profile"], [data-loader-portrait] img')];
            s.imgs = all.map((i) => { const q = i.getBoundingClientRect(); return [i.alt, Math.round(q.width * 10) / 10, Math.round(q.height * 10) / 10, i.currentSrc.split('/').slice(-3).join('/')]; });
        }
        if (m && !rec.marks.introFirst) rec.marks.introFirst = t;
        if (img && !rec.marks.portraitFirst) rec.marks.portraitFirst = t;
        if (s.mask && rec.marks.introFirst && !rec.marks.revealStart) {
            const prev = rec.samples.findLast((p) => p.mask);
            if (prev && s.mask > prev.mask + 0.01) rec.marks.revealStart = prev.t;
        }
        if (!m && rec.marks.introFirst && !rec.marks.maskGone) rec.marks.maskGone = t;
        rec.samples.push(s);
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
});

const cdp = await context.newCDPSession(page);
const frames = [];
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    frames.push({ ts: metadata.timestamp * 1000, data });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, everyNthFrame: 1, maxWidth: maxW, maxHeight: maxH });

let stopMouse = false;
// Off the card, then each corner of the card's box in turn (held 500 ms), then
// the top-right corner again through the handoff, timed from the portrait's first paint.
const cornerLoop = async () => {
    const c = [vw / 2, vh / 2];
    const steps = [[0, [200, 150]], [500, [c[0] - 130, c[1] - 130]], [1000, [c[0] + 130, c[1] - 130]], [1500, [c[0] + 130, c[1] + 130]], [2000, [c[0] - 130, c[1] + 130]], [2500, [c[0] + 130, c[1] - 130]]];
    let first = null;
    while (!stopMouse && first === null) {
        first = await page.evaluate(() => window.__rec?.marks?.portraitFirst ?? null).catch(() => null);
        if (first === null) await new Promise((r) => setTimeout(r, 10));
    }
    for (const [at, [x, y]] of steps) {
        while (!stopMouse && Date.now() < first + at) await new Promise((r) => setTimeout(r, 5));
        if (stopMouse) return;
        // Two short moves, so the card sees a mousemove inside it at the target.
        await page.mouse.move(x - 2, y - 2).catch(() => {});
        await page.mouse.move(x, y).catch(() => {});
        await page.evaluate((s) => { window.__rec.mouse = window.__rec.mouse || []; window.__rec.mouse.push([Date.now(), s]); }, [at, x, y]).catch(() => {});
    }
};
const mouseLoop = async () => {
    // A slow circle over the portrait, 140 px across, a turn every 1.6 s.
    const t0 = Date.now();
    while (!stopMouse) {
        const a = ((Date.now() - t0) / 1600) * Math.PI * 2;
        await page.mouse.move(vw / 2 + Math.cos(a) * 140, vh / 2 + Math.sin(a) * 140).catch(() => {});
        await new Promise((r) => setTimeout(r, 16));
    }
};

const navAt = Date.now();
await page.goto(url, { waitUntil: 'commit' });
const mousing = corners ? cornerLoop() : mouse ? mouseLoop() : null;
// Until the mask is gone, then the tail.
const deadline = Date.now() + 12000;
let gone = null;
while (Date.now() < deadline) {
    const marks = await page.evaluate(() => window.__rec?.marks).catch(() => null);
    if (marks?.maskGone) { gone = marks.maskGone; break; }
    await new Promise((r) => setTimeout(r, 100));
}
await new Promise((r) => setTimeout(r, tail));
stopMouse = true;
await mousing;
await cdp.send('Page.stopScreencast');
const rec = await page.evaluate(() => window.__rec);
const finalShot = await page.screenshot();
fs.writeFileSync(path.join(out, 'final.png'), finalShot);
await browser.close();

const zero = rec.marks.revealStart ?? gone ?? navAt;
const named = [];
for (const [i, f] of frames.entries()) {
    const rel = Math.round(f.ts - zero);
    const name = `${String(i).padStart(4, '0')}_${rel >= 0 ? '+' : '-'}${String(Math.abs(rel)).padStart(5, '0')}ms.jpg`;
    fs.writeFileSync(path.join(out, 'frames', name), Buffer.from(f.data, 'base64'));
    named.push({ name, rel, sinceNav: Math.round(f.ts - navAt) });
}
const marks = Object.fromEntries(Object.entries(rec.marks).map(([k, v]) => [k, { sinceNav: v - navAt, sinceReveal: v - zero }]));
const samples = rec.samples.map((s) => ({ ...s, rel: s.t - zero, t: undefined }));
fs.writeFileSync(path.join(out, 'timeline.json'), JSON.stringify({ url, viewport: [vw, vh], dpr, mobile, mouse: corners ? 'corners' : mouse, mouseSteps: (rec.mouse ?? []).map(([t, s]) => ({ sinceReveal: t - zero, step: s })), photoDelay, navAt, zero: 'revealStart', marks, frames: named, samples }, null, 1));
const gaps = named.slice(1).map((f, i) => f.rel - named[i].rel);
console.log(JSON.stringify({ out, frames: named.length, marks, medianGapMs: gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? null }));
