import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import { makeCuratorSecrets, type TestCuratorSecrets } from '../../test/helpers/curatorSecrets';
import { retryOnAddrInUse } from '../../test/helpers/ports';
import { HOME_OPENING, HOME_ORDER, HOME_PHOTO_IDS, HOME_SERIES } from '../support/catalog-home';
import { createInboxFixture, OPENED_INBOX_ITEMS, openInboxItems, type InboxFixture } from '../support/curation-inbox';
import { failImage } from '../support/failImage';
import { publishHomeFixture } from '../support/homeFixture';
import { compare, completeHiddenSegments, failures, walk, type Allowance, type Comparison, type Walk } from './computed';
import { cameraRowDeparture, FACT_ROWS, readFactRows, type FactRow } from '../../test/helpers/viewerFacts';
import { INBOX_HYDRATION_TIMEOUT, waitForInboxForms } from '../../test/helpers/inboxReady';

// Dark is today's site, exactly (the owner's ruling, 2026-10-29: the remap; it was Black until then). This loads the
// same page states from two builds, the base (PARITY_BASE_DIR: next before the themes) and the head, on the same
// fixtures, a dark device and reduced motion.
//
// The gate is computed style (the lead's ruling, 2026-10-29; spec §10; test/helpers/parityWalk.ts). The base doesn't render
// the same pixels twice: its own photographs, the intro's ripples and a focus ring's edge differ from one load to the
// next, so a pixel gate flakes on the base itself. What Dark is made of can be compared exactly instead:
// 1. Tokens: every custom property the base resolves on :root and body must resolve the same in the head's Dark. New
//    tokens are allowed, and listed.
// 2. Elements: every element under body (and in the curator's preview frame), matched by a path of tag and
//    nth-of-type, with its ::before, ::after, ::placeholder and ::marker: paint, backgrounds, borders and radii, type and
//    its decoration, crop, clipping and stacking, compositing, SVG paint, visibility and display, all exact (parityWalk.ts
//    lists them), and its box exact, every delta logged, with one named allowance (the Inbox's KG ring at 390). A
//    missing or extra element fails, by path. The theme control and today's toggle are left out with their subtrees,
//    and the slot that holds only them is compared by style alone; the curator's head takes its control out of the
//    layout, as no JavaScript does, since the base's header had none. A wait that times out fails the row, so a head
//    that doesn't hydrate fails.
// At 1440, 1024 and 390, in all three of Dark's routes: System on a dark device and today's stored `dark`, each
// against the base on its stored `dark`, and no JavaScript against the base without it. Home's intro has a fourth:
// motion allowed, on a paused clock run to a fixed point in its loading phase, where the grain and the ripples are.
// The gate also walks hover and focus on the nav links, Home's controls (their hover only with motion allowed), About's
// links, and the Inbox's rows and buttons.
// Self-tests inject a change into the head that must fail the gate: Home's scrim and --gah-ink 1/255 off, the glass
// blur at 13px, a photograph's opacity at .96 and its corners square, About's link labels underlined red, a hovered
// nav link white, the intro's grain at .12 and a hovered Home control, both with motion allowed, and the Viewer's bands
// gone.
//
// What the gate can't see is raster only: how the browser draws a blur, a resample or an antialiased edge. The pixel
// report covers that, as an artefact, not a gate: two passes over every shot at 1x and 2x, each in its own fresh load
// with its style in before first paint (chrome with every photograph taken out, or a checkerboard under glass; then
// the photographs alone), the base against itself beside the head against the base.
// The visitor pages, the 404 and the error page; the curator signed out and in, and its 503. The legacy Gallery and
// its lightbox were pairs too, until #13's slice E took them off the visitor side (the note above CURATOR says why).

const BASE = process.env.PARITY_BASE_DIR;
const HEAD = process.cwd();
const OUT = path.join(HEAD, 'test-results', 'parity');
/** For the pixel report: a photograph's own step up to 12/255 is invisible. The Inbox's 56 px thumbnails step up to
 * 9/255 against themselves in the base. */
const PHOTO_STEP = 12;
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } } as const;
/** The gate walks a third width too (spec §13 P3-14): the 40rem to 64rem bands that 1440 and 390 never show. The pixel report stays at two. */
const GATE_VIEWPORTS = { desktop: VIEWPORTS.desktop, tablet: { width: 1024, height: 768 }, phone: VIEWPORTS.phone } as const;
/**
 * Motion allowed runs on a fake clock, paused from before the load, so both builds see the same time: the page loads
 * and decodes with no time passing, then the clock runs `at` ms in one go. After the act, every CSS animation and
 * transition is put at a fixed point, a finite one at its end and an endless one at its start, since they run on the
 * real clock (Home's slow zoom would otherwise be caught mid-way). `hold` walks the intro inside its loading phase.
 */
interface Motion {
    at: number;
    hold?: boolean;
}
const CLOCK_START = Date.UTC(2026, 0, 1);
/**
 * Home's intro at its first frame, the grain up and the first ripple at its start. A later point isn't the same in
 * both builds: React commits a ripple on the real clock, so a ripple's animation starts a few fake ms apart.
 */
const LOADING: Motion = { at: 0, hold: true };
/** Home past its intro, its badge landed and done lingering: the exit's 6 s bound, then the badge's 3 s. */
const SETTLED: Motion = { at: 12_000 };
/**
 * Home with JavaScript is on that paused clock under reduced motion too, so none of its timers fires on its own between
 * the load and the walk, in either build: the badge's linger, the chrome's idle and fade, the loading bounds. On the real
 * clock they did (A12's CI, runs 42210528925 and 42233383736): the badge wait could pass in the one commit where the
 * badge has landed and its linger hasn't started yet, so one build was walked with the badge lingering (opacity 1) and
 * the other after it (0); and in home-chrome the chrome recedes 4 s after the act. Paused, the linger starts and holds
 * until the clock runs past it, BADGE_LINGER_MS (HeroReveal's), and a revealed chrome stays up through the walk. A longer
 * linger in HeroReveal leaves the badge lingering, and the badge wait then times out and fails the row. Only the gate's
 * walks are pinned. The pixel report, an artefact and not a gate, stays on the real clock: its paint wait is two
 * requestAnimationFrame calls, which the paused clock never runs (39c8f7a4 pinned it too, and every Home pair with a
 * pixel report hung to the test timeout in CI).
 */
const BADGE_LINGER_MS = 3000;
const SCALES = [1, 2] as const;
// Rows go to a file as they're measured: a failed test restarts the worker, which would drop rows held in memory.
// build.ts, the global setup, starts it empty.
const ROWS = path.join(OUT, 'dark-parity.rows');
const record = (row: string) => fs.appendFileSync(ROWS, `${row}\n`);
const RECTS = path.join(OUT, 'dark-parity.rects');

// One worker, in order, and soft checks, so one page's difference never skips the others.
// In CI a missing base is a broken job, not a skip: a skipped spec would leave the Themes job green.
if (!BASE && process.env.CI) throw new Error('PARITY_BASE_DIR is required in CI (the Themes job sets it).');
test.skip(!BASE, 'Set PARITY_BASE_DIR to a built checkout of the base; CI\'s Themes job does.');

// --- Servers -----------------------------------------------------------------------------------------------------

const pinned = (process.env.PARITY_PORTS ?? '').split(',').map(Number).filter(Boolean);


interface Server {
    origin: string;
    stop: () => Promise<void>;
}

type Env = Record<string, string>;

/**
 * `next start` from `tree`'s build on 127.0.0.1, with `env`, answering `status` on `ready`. A pinned `port` is used
 * as it is. With none, it takes a free one, and a fresh one if a server finds its port taken (test/helpers/ports.ts),
 * so `env` can be a builder for the env of whichever port it lands on.
 */
function serve(tree: string, port: number | null, env: Env | ((port: number) => Env), ready: string, status = 200): Promise<Server> {
    const on = (listen: number) => serveOn(tree, listen, typeof env === 'function' ? env(listen) : env, ready, status);
    return port === null ? retryOnAddrInUse(on) : on(port);
}

async function serveOn(tree: string, port: number, env: Env, ready: string, status: number): Promise<Server> {
    const kept = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PHOTOGRAPHY_') && !name.startsWith('CURAT') && name !== 'SITE_URL'));
    const child: ChildProcess = spawn(process.execPath, [path.join(tree, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
        cwd: tree,
        env: { ...kept, NODE_ENV: 'production', ALLOW_PROVISIONAL_COPY: '1', NEXT_TELEMETRY_DISABLED: '1', ...env },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => (output += chunk));
    child.stderr?.on('data', (chunk) => (output += chunk));
    const kill = (signal: NodeJS.Signals) => {
        try {
            if (child.pid) process.kill(-child.pid, signal);
        } catch {
            // Gone already.
        }
    };
    process.once('exit', () => kill('SIGKILL'));
    const stop = () =>
        new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            const force = setTimeout(() => kill('SIGKILL'), 5000);
            child.once('exit', () => {
                clearTimeout(force);
                resolve();
            });
            kill('SIGTERM');
        });
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) break;
        const got = await fetch(`${origin}${ready}`).then((response) => response.status, () => 0);
        if (got === status) return { origin, stop };
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await stop();
    throw new Error(`${tree} on ${port} never answered ${status} on ${ready}:\n${output}`);
}

// --- Shots and diffs ---------------------------------------------------------------------------------------------

type Box = { x: number; y: number; w: number; h: number };
interface Shot {
    /** Pass 1: the page with every photograph taken out (opacity 0, so the layout stays), and slides without their images. */
    chrome: string;
    /** Pass 2: the photographs alone, every other layer painting nothing. */
    photo: string;
    /** Every theme control or toggle on the page, the curator's preview frame's included, in page pixels. */
    controls: Box[];
    /** Every photograph's box, the same way. */
    photos: Box[];
    /** Each photograph's compositing, from pass 2's load (D2). */
    styles: string[];
}
interface Pair {
    /** The page, as `name` in the table. */
    name: string;
    url: string;
    /** After the load: reveal Home's chrome, scroll to the sequence, open the Viewer, hover or focus a photograph. */
    act?: (page: Page) => Promise<void>;
    /** Home's intro, at its settled frame: under reduced motion the intro never plays, and the badge fades in where it lands. */
    intro?: boolean;
    /** A signed-in curator page. */
    session?: boolean;
    /**
     * Home with the photograph after the opening one failing to load, so Next from the keyboard brings the failure
     * notice with Retry and Skip. Since #4's opening walk (v2.0.0) a failed opening moves on instead of showing it.
     */
    failNext?: boolean;
    /** A page the head adds the control to, where the base had no toggle (the curator's header): the head's shot
     * takes the control out of the layout, as no JavaScript does, so the rest must match. */
    addsControl?: boolean;
    /** A page that never hydrates (the 503). */
    bare?: boolean;
    /** Glass over the photographs (Home's SiteNav): pass 1 paints each photo as a checkerboard (D1). */
    glass?: boolean;
    /** CSS for the head's shots only: the self-test's deliberate change. */
    headStyle?: string;
    /** Selectors whose boxes go in the report's second table, unrounded, from every shot (the code review's H2.3). */
    measure?: string[];
    /** Motion allowed, on the fake clock, in every route of this page. */
    motion?: Motion;
    /** A hover or focus state: the gate walks it, and the pixel report leaves it out. */
    gateOnly?: boolean;
    /** The page this is a state of, whose allowances it takes. */
    stateOf?: string;
    /** Elements both walks leave out with their subtrees, where the builds differ on purpose and another pair compares them. */
    leaveOut?: { selector: string; why: string }[];
    /**
     * A Viewer page with the details list (#175): the base's Camera make row, its first, is left out of the base's
     * walk, since the head merged it into Camera, and both builds' rows are read and held to cameraRowDeparture().
     */
    cameraRows?: true;
}

let browser: Browser;

/** Pass 1's style: no photograph's pixels, and a slide's image off, so whatever is drawn over or around a photograph composites over the same ground in both builds. */
const NO_PHOTOS = 'img,picture,canvas,video{opacity:0!important}[class$="_slide"],[class*="_slide "]{background-image:none!important}';
/**
 * Pass 1 on a page with glass over its photographs (D1): each photo's box is the same fixed checkerboard in both
 * builds instead, so a blur or a saturate over it shows. The image keeps its box and draws only its background.
 */
const CHECKER = 'repeating-conic-gradient(#000 0 25%,#fff 0 50%) 0 0/8px 8px';
const CHECKERED_PHOTOS = `img,video{object-position:-100000px -100000px!important;background:${CHECKER}!important;opacity:1!important}picture,canvas{opacity:0!important}[class$="_slide"],[class*="_slide "]{background:${CHECKER}!important}`;
/**
 * Pass 2's style: nothing paints but the photographs. Every other layer stays in place, visible and focusable, so the
 * page's acts (a hover, a focus, the lightbox's Enter) work the same in both passes; it only paints nothing: no ink,
 * ground, rule, shadow, ring or glass. Filters stay, since a photo's own compositing is under test (D2).
 */
const ONLY_PHOTOS =
    'body *:not(img):not(video):not(canvas),body *::before,body *::after{color:transparent!important;-webkit-text-fill-color:transparent!important;' +
    'background:transparent!important;border-color:transparent!important;box-shadow:none!important;outline-color:transparent!important;' +
    'text-shadow:none!important;text-decoration-color:transparent!important;caret-color:transparent!important;' +
    'backdrop-filter:none!important;-webkit-backdrop-filter:none!important}';

type PassName = 'chrome' | 'photo';
interface PassShot {
    file: string;
    controls: Box[];
    photos: Box[];
    /** Each photograph's own opacity, filter and blend, and every ancestor's opacity and filter, in DOM order (D2). */
    styles: string[];
}

/**
 * One fresh load of `pair`, settled (D3): `css` (a pass's style, the head's own) is in from before first paint,
 * through an init script in every frame, never toggled on a live page. Then hydration, fonts, every image loaded and
 * decoded, and every finite animation done. `stored` is the theme in localStorage, or '' for none (System). Without
 * JavaScript nothing waits on the page's scripts, and an act that needs them does nothing, in both builds alike.
 * `pin` puts Home on the paused clock for the gate's walk (BADGE_LINGER_MS's note).
 */
async function open(origin: string, stored: string, pair: Pair, viewport: { width: number; height: number }, scale: number, css: string, { js = true, session, motion = pair.motion, pin = false }: { js?: boolean; session?: string; motion?: Motion; pin?: boolean } = {}) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: scale, colorScheme: 'dark', reducedMotion: motion ? 'no-preference' : 'reduce', javaScriptEnabled: js });
    // Home's timers, held still (BADGE_LINGER_MS's note).
    const homeClock = pin && !motion && js && pair.url === '/';
    if (motion || homeClock) {
        await context.clock.install({ time: CLOCK_START });
        await context.clock.pauseAt(CLOCK_START + 1);
    }
    if (session) await context.addCookies(JSON.parse(session).map((cookie: { name: string; value: string }) => ({ ...cookie, url: origin })));
    await context.addInitScript(({ value, sheet }) => {
        try {
            if (value) localStorage.setItem('theme', value);
        } catch {
            // No storage.
        }
        if (!sheet) return;
        // An adopted sheet needs no <head>, so it's in before the parser writes one, and nothing the page does removes it.
        const style = new CSSStyleSheet();
        style.replaceSync(sheet);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, style];
    }, { value: stored, sheet: css });
    const page = await context.newPage();
    if (pair.failNext) await page.route(`**/media/${HOME_ORDER[(HOME_ORDER.indexOf(HOME_OPENING) + 1) % HOME_ORDER.length]}/**`, (route) => route.abort());
    // Every wait polls from here, so it works without JavaScript too (the page then runs none of our timers or
    // handlers), and every one that times out is named in `timedOut`: the gate fails a row on any, never passes it.
    const timedOut: string[] = [];
    const until = async (name: string, check: () => Promise<boolean>, ms: number) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            if (await check().catch(() => false)) return;
            await page.waitForTimeout(100);
        }
        timedOut.push(name);
    };
    // The page and the curator's preview frame: every image that's going to load has (a lazy one far out of view won't),
    // and its fonts are in. With JavaScript, every image is decoded too: loaded isn't painted, and a photo still
    // decoding can draw a row short.
    const settleImages = async () => {
        await until('images and fonts', () => page.evaluate(() => {
            const docs = [document, ...[...document.querySelectorAll('iframe')].flatMap((frame) => (frame.contentDocument ? [frame.contentDocument] : []))];
            return docs.every((doc) => doc.fonts.status === 'loaded' && [...doc.images].every((image) => {
                if (image.complete) return true;
                const box = image.getBoundingClientRect();
                const view = doc.defaultView!;
                // Chrome loads a lazy image within 1,250 px of the viewport; one further out never loads, in either build.
                return image.loading === 'lazy' && (box.bottom < -1000 || box.top > view.innerHeight + 1000);
            }));
        }), 20_000);
        if (js) await until('image decode', () => page.evaluate(async () => {
            const docs = [document, ...[...document.querySelectorAll('iframe')].flatMap((frame) => (frame.contentDocument ? [frame.contentDocument] : []))];
            await Promise.all(docs.flatMap((doc) => [...doc.images].filter((image) => image.complete).map((image) => image.decode().catch(() => undefined))));
            return true;
        }), 10_000);
    };
    await page.goto(`${origin}${pair.url}`, { waitUntil: pair.intro && js && !motion ? 'domcontentloaded' : 'load' });
    if (js && !pair.bare) await until('hydration', () => page.locator('html[data-hydrated]').count().then((n) => n > 0), 30_000);
    await until('fonts', () => page.evaluate(() => document.fonts.status === 'loaded'), 10_000);
    if (motion && js) {
        // Everything in before the clock moves, so the intro's loading ends at the same time on it in both builds.
        await settleImages();
        if (motion.at > 0) await context.clock.runFor(motion.at);
        // The grain up and Home's root in its loading phase, not revealing, in both builds.
        if (motion.hold) {
            await until("Home's intro in its loading phase", async () => (await page.locator('[class*="grainOverlay"]').count()) === 1 && (await page.locator('main[data-home-intro="loading"]').count()) === 1, 5000);
        }
    }
    if (homeClock) {
        // Lingering holds on the paused clock, so this can't pass early; then the clock runs past the linger, and stops.
        await until("Home's badge lingering", () => page.locator('[data-home-badge][data-landed][data-lingering]').count().then((n) => n > 0), 20_000);
        await context.clock.runFor(BADGE_LINGER_MS);
    }
    if (js && pair.url === '/' && !motion?.hold) await until("Home's badge", () => page.locator('[data-home-badge][data-landed]:not([data-lingering])').count().then((n) => n > 0), 20_000);
    // Without JavaScript a state act is left out: its row then compares the page at rest, as another pair does, and no
    // act abandoned at 3 s can still be pressing keys during the walk.
    if (js) await pair.act?.(page);
    else if (!pair.gateOnly) await Promise.race([pair.act?.(page).catch(() => undefined), page.waitForTimeout(3000)]);
    await settleImages();
    if (motion && js) {
        await page.evaluate(() => {
            for (const animation of document.getAnimations()) {
                if (animation.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY) {
                    animation.pause();
                    animation.currentTime = 0;
                } else animation.finish();
            }
        });
    }
    // Every finite animation and transition done (reduced motion fades Home's badge in once loading ends). With motion
    // allowed they're at their fixed points already.
    await until('animations', () => page.evaluate(() => document.getAnimations().every((animation) => animation.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY || animation.playState !== 'running')), 5000);
    await page.waitForTimeout(600);
    return { context, page, timedOut };
}

/** One pass's capture, from its own fresh load: the shot, the controls' and photographs' boxes, and the photos' compositing. */
async function load(origin: string, stored: string, pair: Pair, viewport: { width: number; height: number }, scale: number, tag: string, pass: PassName, session?: string): Promise<PassShot> {
    const head = !tag.startsWith('base');
    const css = [
        pass === 'chrome' ? (pair.glass ? CHECKERED_PHOTOS : NO_PHOTOS) : ONLY_PHOTOS,
        pair.addsControl && head ? '[data-theme-control]{display:none!important}' : '',
        pair.headStyle && head ? pair.headStyle : '',
    ].join('');
    const { context, page } = await open(origin, stored, pair, viewport, scale, css, { session });
    // The control in the page and in any same-origin frame: today's toggle in the base, the theme control in the head.
    // Every photograph's box, unrounded. And each photograph's own compositing, with its ancestors'.
    const { controls, photos, styles } = await page.evaluate(() => {
        const boxes: { x: number; y: number; w: number; h: number }[] = [];
        const photoBoxes: typeof boxes = [];
        const compositing: string[] = [];
        const visit = (doc: Document, dx: number, dy: number) => {
            const view = doc.defaultView!;
            for (const el of doc.querySelectorAll('[data-theme-control], nav button, header button')) {
                if (!el.matches('[data-theme-control]') && !/^Switch to/.test((el.textContent ?? '').trim())) continue;
                const box = el.getBoundingClientRect();
                if (box.width === 0) continue;
                // Out to the whole pixels it touches: a box at x 16.5 also paints part of pixel 16 and of pixel 72.
                const [left, top] = [Math.floor(box.left + dx), Math.floor(box.top + dy)];
                boxes.push({ x: left, y: top, w: Math.ceil(box.right + dx) - left, h: Math.ceil(box.bottom + dy) - top });
            }
            for (const el of doc.querySelectorAll('img, picture, canvas, video, [class$="_slide"], [class*="_slide "]')) {
                const box = el.getBoundingClientRect();
                if (box.width > 0) photoBoxes.push({ x: box.left + dx, y: box.top + dy, w: box.width, h: box.height });
            }
            for (const el of doc.querySelectorAll('img, picture, canvas, video')) {
                const own = view.getComputedStyle(el);
                const chain: string[] = [];
                for (let node = el.parentElement; node; node = node.parentElement) {
                    const style = view.getComputedStyle(node);
                    if (style.opacity !== '1' || style.filter !== 'none') chain.push(`${node.tagName.toLowerCase()} opacity ${style.opacity} filter ${style.filter}`);
                }
                compositing.push(`${el.tagName.toLowerCase()} ${(el as HTMLImageElement).alt ?? ''}: opacity ${own.opacity}, filter ${own.filter}, blend ${own.mixBlendMode}${chain.length ? `; ${chain.join('; ')}` : ''}`);
            }
            for (const frame of doc.querySelectorAll('iframe')) {
                const inner = frame.contentDocument;
                const at = frame.getBoundingClientRect();
                if (inner) visit(inner, dx + at.x + frame.clientLeft, dy + at.y + frame.clientTop);
            }
        };
        visit(document, window.scrollX, window.scrollY);
        return { controls: boxes, photos: photoBoxes, styles: compositing };
    });
    if (pass === 'chrome') {
        for (const selector of pair.measure ?? []) {
            const box = await page.locator(selector).first().evaluate((el) => {
                const r = el.getBoundingClientRect();
                return `${r.x} ${r.y} ${r.width} ${r.height}`;
            }).catch(() => 'absent');
            fs.appendFileSync(RECTS, `| ${pair.name} | ${viewport.width} ${scale}x | ${tag} | \`${selector}\` | ${box} |\n`);
        }
    }
    // Two frames, so what the last wait changed is painted.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const file = path.join(OUT, `${pair.name}-${viewport.width}-${scale}x-${tag}-${pass}.png`);
    await page.screenshot({ path: file, fullPage: pair.session === true && pair.url.includes('publish') });
    await context.close();
    return { file, controls, photos, styles };
}

async function shoot(origin: string, stored: string, pair: Pair, viewport: { width: number; height: number }, scale: number, tag: string, session?: string): Promise<Shot> {
    const chrome = await load(origin, stored, pair, viewport, scale, tag, 'chrome', session);
    const photo = await load(origin, stored, pair, viewport, scale, tag, 'photo', session);
    // The controls from both loads: pass 2 hides them, but a mask from either covers both captures.
    return { chrome: chrome.file, photo: photo.file, controls: [...chrome.controls, ...photo.controls], photos: photo.photos, styles: photo.styles };
}

interface Diff {
    /** Pass 1: pixels differing anywhere outside the controls' boxes. Must be 0. */
    count: number;
    /** The largest channel step among them. */
    maxStep: number;
    /** Pass 2: the largest channel step inside the photographs' boxes. At most PHOTO_STEP. */
    photoStep: number;
    /** Where the chrome differs. */
    box: string;
    /** Photographs whose compositing differs between the two builds (D2): must be none. */
    styles: string[];
}

type Region = { x0: number; y0: number; x1: number; y1: number };

/** Two same-sized captures, raw. */
async function pixels(left: string, right: string) {
    const [a, b] = await Promise.all([left, right].map((file) => sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true })));
    return a.info.width === b.info.width && a.info.height === b.info.height ? { a, b, width: a.info.width, height: a.info.height } : null;
}

/** Pass 1 compares the whole frame exactly, but the controls' boxes (±2 CSS px); pass 2 only the photographs' boxes, by their largest step. */
async function diff(a: Shot, b: Shot, scale: number, name: string): Promise<Diff> {
    const device = (pad: number) => (box: Box): Region => ({ x0: (box.x - pad) * scale, y0: (box.y - pad) * scale, x1: (box.x + box.w + pad) * scale, y1: (box.y + box.h + pad) * scale });
    const masks = [...a.controls, ...b.controls].map(device(2));
    // A photograph's edge row or column, where it covers a pixel only in part, blends with whatever is under it, and
    // the resampler lands it up to 99/255 apart from one load to the next. Pass 1 holds that pixel's chrome exact;
    // pass 2 counts only the pixels a photograph covers whole, in to the whole pixels inside its box.
    const photos = [...a.photos, ...b.photos].map((box): Region => ({ x0: Math.ceil(box.x * scale), y0: Math.ceil(box.y * scale), x1: Math.floor((box.x + box.w) * scale), y1: Math.floor((box.y + box.h) * scale) }));
    const inside = (boxes: Region[], x: number, y: number) => boxes.some((m) => x >= m.x0 && x < m.x1 && y >= m.y0 && y < m.y1);
    const step = (left: Buffer, right: Buffer, i: number) => Math.max(Math.abs(left[i] - right[i]), Math.abs(left[i + 1] - right[i + 1]), Math.abs(left[i + 2] - right[i + 2]));

    const chrome = await pixels(a.chrome, b.chrome);
    const photo = await pixels(a.photo, b.photo);
    const styles = a.styles.length === b.styles.length ? a.styles.flatMap((line, index) => (line === b.styles[index] ? [] : [`${line} against ${b.styles[index]}`])) : [`${a.styles.length} photographs against ${b.styles.length}`];
    if (!chrome || !photo) return { count: Number.POSITIVE_INFINITY, maxStep: 255, photoStep: 255, box: 'the two captures differ in size', styles };

    let count = 0;
    let maxStep = 0;
    let x0 = chrome.width, y0 = chrome.height, x1 = -1, y1 = -1;
    const mark = new Uint8Array(chrome.width * chrome.height * 3);
    for (let y = 0; y < chrome.height; y++) {
        for (let x = 0; x < chrome.width; x++) {
            const i = (y * chrome.width + x) * 3;
            mark[i] = mark[i + 1] = mark[i + 2] = Math.round((chrome.a.data[i] + chrome.a.data[i + 1] + chrome.a.data[i + 2]) / 9);
            const d = step(chrome.a.data, chrome.b.data, i);
            if (d === 0 || inside(masks, x, y)) continue;
            count++;
            maxStep = Math.max(maxStep, d);
            mark[i] = 255;
            mark[i + 1] = mark[i + 2] = 0;
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
    }
    if (count > 0) await sharp(Buffer.from(mark), { raw: { width: chrome.width, height: chrome.height, channels: 3 } }).png().toFile(path.join(OUT, `${name}-chrome-diff.png`));

    let photoStep = 0;
    for (let y = 0; y < photo.height; y++) {
        for (let x = 0; x < photo.width; x++) {
            if (!inside(photos, x, y) || inside(masks, x, y)) continue;
            photoStep = Math.max(photoStep, step(photo.a.data, photo.b.data, (y * photo.width + x) * 3));
        }
    }
    const css = (v: number) => Math.round(v / scale);
    return { count, maxStep, photoStep, box: count ? `x ${css(x0)} to ${css(x1)}, y ${css(y0)} to ${css(y1)}` : '', styles };
}

// --- Pages -------------------------------------------------------------------------------------------------------

const series = `/work/${HOME_SERIES.slug}`;
const revealChrome = async (page: Page) => {
    const { width, height } = page.viewportSize()!;
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.move(width / 2 + 40, height / 2 + 10);
};
/** Scrolls `target`'s top to 80 px under the viewport's, to a whole pixel, so both builds land on the same offset. */
const scrollToWhole = (target: Locator) =>
    target.evaluate((element) => window.scrollTo(0, Math.max(0, Math.round(element.getBoundingClientRect().top + window.scrollY) - 80)));
/** Focuses without the browser's own scroll, which picks its offset mid layout and can land a fraction apart. */
const focusInPlace = async (target: Locator) => {
    await target.evaluate((element) => (element as HTMLElement).focus({ preventScroll: true }));
    // The ring draws only on :focus-visible: a shot without it would compare nothing.
    expect(await target.evaluate((element) => element.matches(':focus-visible')), 'the focused element shows its ring').toBe(true);
};
const toSequence = (page: Page) => scrollToWhole(page.getByRole('heading', { name: 'Sequence' }));
/** A primary nav link other than the current page's. */
const navLink = (page: Page) => page.locator('nav[aria-label="Primary"] ul a:not([aria-current])').first();
/** Hovers `target`, which must be there: a state act on nothing would compare nothing. */
const hoverOn = async (target: Locator) => {
    await expect(target, 'the hovered element is there').toBeVisible();
    await target.hover();
};
/**
 * A key press first, so the focus that follows is :focus-visible, as a keyboard visitor's is. Where focusing it then
 * doesn't show the ring (the Inbox), it's reached by Tab, as a keyboard visitor does.
 */
const keyboardFocus = async (page: Page, target: Locator) => {
    await page.keyboard.press('Tab');
    await target.evaluate((element) => (element as HTMLElement).focus({ preventScroll: true }));
    for (let presses = 0; presses < 80 && !(await target.evaluate((element) => element === document.activeElement && element.matches(':focus-visible'))); presses++) {
        await page.keyboard.press('Tab');
    }
    const state = await target.evaluate((element) => ({
        ring: element.matches(':focus-visible'),
        focused: element === document.activeElement,
        active: `${document.activeElement?.tagName.toLowerCase()} ${document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim().slice(0, 40) ?? ''}`,
    }));
    expect(state.ring, `the focused element shows its ring (focused ${state.focused}, focus on ${state.active})`).toBe(true);
};
const homeNext = (page: Page) => page.getByRole('button', { name: 'Next photograph' });
const homeEnter = (page: Page) => page.getByRole('link', { name: /^Enter the series/ });
const homeRetry = (page: Page) => page.getByRole('button', { name: 'Retry', exact: true });
/**
 * The slides, left out of the failure pairs' walks: on a failed Next the base puts the failed slide (its LQIP) on screen,
 * and #4 keeps the photograph that showed (v2.0.0). The carousel itself is still compared, and every other Home pair
 * compares the slides too.
 */
const FAILED_NEXT_STACK = [{ selector: '[data-photo-id]', why: '#4: a failed Next keeps the photograph on screen' }];
/** Next from the keyboard onto the photograph failNext fails, which both builds answer with the notice, Retry and Skip. */
const failNextFromKeyboard = async (page: Page) => {
    await revealChrome(page);
    await keyboardFocus(page, homeNext(page));
    await page.keyboard.press('Enter');
    await expect(homeRetry(page), 'the failure notice is up').toBeVisible();
};
const aboutLink = (page: Page) => page.locator('main article a').first();
/**
 * The Inbox streams in after hydration, behind its loading state: an act before the list is in would focus a row that
 * the list then replaces, leaving focus on the body. React's inline script shows the list before the Inbox hydrates,
 * and html[data-hydrated] is the shell's, so the act also waits for the Inbox's own forms: none still waiting at the
 * submit gate, and each one claimed by React. The base (v1.2.0) has no gate, so that half holds there at once, and
 * the React half is the wait in both builds.
 */
const inboxIn = async (page: Page, { timeout = INBOX_HYDRATION_TIMEOUT }: { timeout?: number } = {}) => {
    await expect(page.locator('main ul a[data-row]').first(), 'the Inbox list is in').toBeVisible();
    await expect(page.getByText('Loading the inbox'), "the Inbox's loading state is gone").toBeHidden();
    // Bounded, and named when it fails (test/helpers/inboxReady.ts): a form that never hydrates fails the pair, never a
    // walk of a page that isn't there yet.
    await waitForInboxForms(page, { timeout });
};
const inboxRow = (page: Page) => page.locator('main ul a[data-row]').first();
const inboxRefresh = (page: Page) => page.getByRole('button', { name: 'Refresh inbox' });
/** The cover's image fails, as a broken file would (its WebP retry too), and the cover keeps its box with the missing-image edge. */
const failCover = async (page: Page) => {
    await failImage(page, 'main figure a img', page.locator('main figure [data-photo="unavailable"]'));
    await expect(page.locator('main figure [data-photo="unavailable"]')).toHaveCount(1);
};

/**
 * The Viewer header's spoken position, which moved into the heading (#175): the base's screen-reader-only span
 * after the padded numbers, gone in the head. Screen-reader only, so neither build gives it room; the padded
 * numbers, the heading and the header around them are still compared.
 */
const VIEWER_POSITION = [{ selector: '[data-surface="viewer"] header p > span.sr-only', why: '#175: the position is said in the heading' }];
/**
 * A sanctioned departure (#175): a Viewer photograph whose file failed says "This photograph could not be
 * loaded.", shows its alt and offers Retry, where the base had the missing-image label alone. Only the box's contents
 * are left out. The box itself is still compared, its Dark paint (ground, edge, diagonal) and its place included,
 * except the scroll it gains for a long alt (the viewer-missing allowance in ALLOWANCES); so are the stage, the moves and the reading area.
 */
const VIEWER_FAILED_BOX = { selector: '[data-surface="viewer"] [data-photo="unavailable"] > *', why: '#175: a failed photograph says so, with its alt and Retry' };

const VISITOR: Pair[] = [
    { name: 'home-intro', url: '/', intro: true, glass: true },
    { name: 'home-rest', url: '/', glass: true },
    { name: 'home-chrome', url: '/', act: revealChrome, glass: true },
    { name: 'work', url: '/work' },
    { name: 'series', url: series },
    { name: 'series-sequence', url: series, act: toSequence },
    // A thumbnail and the cover whose image fails: each holds its box and its missing-image edge (#124's review, M2).
    {
        name: 'thumbnail-fallback',
        url: series,
        act: async (page) => {
            await toSequence(page);
            await failImage(page, 'section[aria-labelledby="series-sequence"] ol li a img', page.locator('[data-photo="unavailable"]'));
            await expect(page.locator('[data-photo="unavailable"]')).toHaveCount(1);
        },
    },
    { name: 'cover-fallback', url: series, act: (page) => failCover(page) },
    // A focused Work entry. Today's ring is the entry link's own, outside it at [data-ring-room]'s 3 px in Dark; since
    // #171 (B3) it's the title link's, inset on its ::after over the whole entry (WORK_ENTRY_FOCUS). The first link
    // in the first entry, in either build.
    {
        name: 'work-focus',
        url: '/work',
        stateOf: 'work',
        act: async (page) => {
            await page.keyboard.press('Shift');
            await focusInPlace(page.getByRole('main').locator('ul > li a').first());
        },
    },
    {
        name: 'thumbnail-hover',
        url: series,
        act: async (page) => {
            await toSequence(page);
            await page.locator('section[aria-labelledby="series-sequence"] ol li a').first().hover();
        },
    },
    {
        name: 'thumbnail-focus',
        url: series,
        act: async (page) => {
            await toSequence(page);
            // A key press first, so the focus that follows is :focus-visible, as a keyboard visitor's is.
            await page.keyboard.press('Tab');
            await focusInPlace(page.locator('section[aria-labelledby="series-sequence"] ol li a').first());
        },
    },
    { name: 'cover-hover', url: series, act: (page) => page.locator('main figure a').first().hover() },
    {
        name: 'cover-focus',
        url: series,
        act: async (page) => {
            await scrollToWhole(page.locator('main figure a').first());
            await page.keyboard.press('Tab');
            await focusInPlace(page.locator('main figure a').first());
        },
    },
    // A failed cover under hover and focus: its mark is today's 1 px ring, with no mat (#124's review, D1).
    {
        name: 'cover-fallback-hover',
        url: series,
        act: async (page) => {
            await failCover(page);
            await page.locator('main figure a').first().hover();
        },
    },
    {
        name: 'cover-fallback-focus',
        url: series,
        act: async (page) => {
            await failCover(page);
            await scrollToWhole(page.locator('main figure a').first());
            await page.keyboard.press('Tab');
            await focusInPlace(page.locator('main figure a').first());
        },
    },
    { name: 'viewer', url: `${series}/photo/${HOME_OPENING}`, leaveOut: VIEWER_POSITION, cameraRows: true },
    // The Viewer's other states (#126's review, L2): another photograph, zoomed, a print that fails, and the modal
    // opened from a series, with its ::backdrop. The modal's styles load with its shell, not the series page
    // (components/viewer/viewerShellLoader.ts), so the open modal is checked against today's too.
    { name: 'viewer-second', url: `${series}/photo/${HOME_PHOTO_IDS[1]}`, leaveOut: VIEWER_POSITION, cameraRows: true },
    {
        name: 'viewer-zoomed',
        cameraRows: true,
        url: `${series}/photo/${HOME_OPENING}`,
        leaveOut: VIEWER_POSITION,
        act: async (page) => {
            await page.locator('[data-surface="viewer"] > header').getByRole('button', { name: 'Zoom' }).click();
            await expect(page.locator('[data-zoomed]')).toHaveCount(1);
        },
    },
    {
        name: 'viewer-missing',
        cameraRows: true,
        url: `${series}/photo/${HOME_OPENING}`,
        leaveOut: [...VIEWER_POSITION, VIEWER_FAILED_BOX],
        act: async (page) => {
            await failImage(page, '[data-viewer-current] img', page.locator('[data-surface="viewer"] [data-photo="unavailable"]'));
            await expect(page.locator('[data-surface="viewer"] [data-photo="unavailable"]')).toHaveCount(1);
        },
    },
    {
        name: 'viewer-modal',
        cameraRows: true,
        url: series,
        leaveOut: VIEWER_POSITION,
        act: async (page) => {
            await page.locator('main figure a').first().click();
            await expect(page.getByRole('dialog')).toBeVisible();
        },
    },
    // The same modal from the sequence's first slot, the other way in (#126's Delta 1, L1').
    {
        name: 'viewer-modal-sequence',
        cameraRows: true,
        url: series,
        leaveOut: VIEWER_POSITION,
        act: async (page) => {
            await toSequence(page);
            await page.locator('section[aria-labelledby="series-sequence"] ol li a').first().click();
            await expect(page.locator('dialog[data-surface="viewer"]')).toBeVisible();
        },
    },
    { name: 'about', url: '/about' },
    { name: '404', url: '/no-such-page', measure: ['nav [class*="monogram"]', 'nav [class*="_end"]', '[data-theme-control], nav button'] },
    // Hover and focus (the review's Delta 2, item 3), walked by the gate only.
    { name: 'nav-link-hover', url: '/work', gateOnly: true, stateOf: 'work', act: (page) => hoverOn(navLink(page)) },
    { name: 'nav-link-focus', url: '/work', gateOnly: true, stateOf: 'work', act: (page) => keyboardFocus(page, navLink(page)) },
    { name: 'about-nav-link-hover', url: '/about', gateOnly: true, stateOf: 'about', act: (page) => hoverOn(navLink(page)) },
    { name: 'about-link-hover', url: '/about', gateOnly: true, stateOf: 'about', act: (page) => hoverOn(aboutLink(page)) },
    { name: 'about-link-focus', url: '/about', gateOnly: true, stateOf: 'about', act: (page) => keyboardFocus(page, aboutLink(page)) },
    {
        name: 'home-control-focus',
        url: '/',
        gateOnly: true,
        glass: true,
        act: async (page) => {
            await revealChrome(page);
            await keyboardFocus(page, homeNext(page));
        },
    },
    // "Enter the series" and the failure notice: the states this PR's tokens reach (the code review's M3).
    {
        name: 'home-enter-hover',
        url: '/',
        gateOnly: true,
        glass: true,
        act: async (page) => {
            await revealChrome(page);
            await hoverOn(homeEnter(page));
        },
    },
    {
        name: 'home-enter-focus',
        url: '/',
        gateOnly: true,
        glass: true,
        act: async (page) => {
            await revealChrome(page);
            await keyboardFocus(page, homeEnter(page));
        },
    },
    {
        name: 'home-failure',
        url: '/',
        gateOnly: true,
        glass: true,
        failNext: true,
        leaveOut: FAILED_NEXT_STACK,
        act: async (page) => {
            await failNextFromKeyboard(page);
        },
    },
    {
        name: 'home-failure-hover',
        url: '/',
        gateOnly: true,
        glass: true,
        failNext: true,
        stateOf: 'home-failure',
        leaveOut: FAILED_NEXT_STACK,
        act: async (page) => {
            await failNextFromKeyboard(page);
            await hoverOn(homeRetry(page));
        },
    },
    // The controls' hover is only with motion allowed and a fine pointer.
    {
        name: 'home-control-hover',
        url: '/',
        gateOnly: true,
        glass: true,
        motion: SETTLED,
        act: async (page) => {
            await revealChrome(page);
            await hoverOn(homeNext(page));
        },
    },
];
// The legacy pairs are gone, on purpose (#13's slice E). The base (be35250a) still has legacy mode, and the gate used
// to start it and the head on a data root with nothing published, to compare the legacy Gallery ('/gallery', on the
// e2e photo fixtures) and its lightbox. The head no longer has either: on that root it answers every page with #21's
// unavailable state, and '/gallery' with a 308 to '/work'. Nothing of the head's renders the base's Gallery, so a pair
// could only compare unlike pages, and loosening the comparison to let one pass would hide a real change, so the pairs
// went with the page. The Gallery's look has no successor to hold to it; Work, which '/gallery' reaches now, is in
// VISITOR, compared as strictly as before. No catalog pair changed, and the base renders Home in catalog form on the
// same fixture, so no pair needs a named entry for the base's legacy Home either.
const CURATOR: Pair[] = [
    { name: 'signin', url: '/curation/login', addsControl: true },
    {
        name: 'inbox',
        url: '/curation/inbox',
        session: true,
        addsControl: true,
        measure: ['header [class*="monogram"]', 'header [class*="wordmark"]', 'header [class*="headerEnd"]', 'header'],
    },
    { name: 'publish', url: '/curation/publish', session: true, addsControl: true },
    { name: 'inbox-row-hover', url: '/curation/inbox', session: true, addsControl: true, gateOnly: true, stateOf: 'inbox', act: async (page) => {
        await inboxIn(page);
        await hoverOn(inboxRow(page));
    } },
    { name: 'inbox-row-focus', url: '/curation/inbox', session: true, addsControl: true, gateOnly: true, stateOf: 'inbox', act: async (page) => {
        await inboxIn(page);
        await keyboardFocus(page, inboxRow(page));
    } },
    { name: 'inbox-button-hover', url: '/curation/inbox', session: true, addsControl: true, gateOnly: true, stateOf: 'inbox', act: async (page) => {
        await inboxIn(page);
        await hoverOn(inboxRefresh(page));
    } },
    { name: 'inbox-button-focus', url: '/curation/inbox', session: true, addsControl: true, gateOnly: true, stateOf: 'inbox', act: async (page) => {
        await inboxIn(page);
        await keyboardFocus(page, inboxRefresh(page));
    } },
];

/** Shoots `pair` from both, at every size and scale, and pins the diff; and, with `legacy`, the head on the preview's stored `charcoal`. */
const row = (label: string, size: string, width: number, scale: number, d: Diff) =>
    record(`| ${label} | ${size} ${width} | ${scale}x | ${d.count} | ${d.maxStep} | ${d.photoStep} | ${d.styles.length} | ${d.box} |`);

// --- The gate: computed style ------------------------------------------------------------------------------------

const STYLE_ROWS = path.join(OUT, 'dark-styles.rows');
const STYLE_DETAILS = path.join(OUT, 'dark-styles.details');

/** A walk of `pair` in one build: every element's computed style and box, and the tokens, from a fresh settled load. */
/**
 * The gate's named allowances (spec §10). The Inbox's KG ring at 390 is back to 0 and its allowance is gone (the curator
 * PR). One sanctioned departure from today's site remains: the curator's selected row and tab take P2-8's 1 px outline
 * in every theme, Dark included, an accessibility fix, since today's fill alone is 1.32:1 against the list.
 *
 * Not compared, as a sanctioned departure: #4's `image-unavailable` Home (v2.0.0), where the opening walk gave up. The
 * base has no such screen: with every photograph failing it offers the opening's notice with Retry and Skip, and the
 * head says "These photographs can't be shown right now." with Retry alone. The notice, Retry and the controls it keeps
 * are the ones home-failure and home-failure-hover compare.
 */
/**
 * #145, the owner's request: on the wide layout the Inbox is one screen tall, its list and its form each scroll on
 * their own, and the photograph's column holds still instead of a sticky frame in the page's scroll. So at the two
 * wide sizes the page wrapper is a flex column, the two panels and the photograph's column clip or scroll, the frame
 * is no longer sticky, and every box the page's height set is the screen's height now: the base's page runs up to
 * 695.7 px taller at these sizes, and the photograph sits 28.5 px lower, centred in a shorter frame. A phone (390) is
 * unchanged, so nothing here applies to it.
 */
const INDEPENDENT_PANELS: Allowance[] = [1024, 1440].flatMap((width): Allowance[] => {
    const why = '#145: the Inbox list and form scroll independently on a wide screen';
    const page = 'inbox';
    const tall = 700;
    return [
        { page, width, selector: 'body', maxDelta: tall, why },
        { page, width, selector: 'body > next-route-announcer', maxDelta: tall, why },
        { page, width, selector: 'div:has(> main > #inbox-list)', properties: ['display'], maxDelta: tall, why },
        { page, width, selector: 'main:has(> #inbox-list)', maxDelta: tall, why },
        { page, width, selector: '#inbox-list', properties: ['overflow-x', 'overflow-y', 'position'], maxDelta: tall, why },
        { page, width, selector: '#item', maxDelta: tall, why },
        { page, width, selector: '#item > div:nth-of-type(2)', properties: ['overflow-x', 'overflow-y'], maxDelta: tall, why },
        { page, width, selector: '#item > div:nth-of-type(2) > div:nth-of-type(1)', properties: ['position'], maxDelta: 57, why },
        { page, width, selector: '#item > div:nth-of-type(2) > div:nth-of-type(1) > img', maxDelta: 28.5, why },
        { page, width, selector: '#item > div:nth-of-type(3)', properties: ['overflow-x', 'overflow-y', 'position'], maxDelta: tall, why },
    ];
});

/**
 * Elements the head adds that the base never had, each named. Like the theme control, each is taken out of the head's
 * layout and left out of the walk in both builds, so the rest of the page is still compared exactly. The report
 * lists them.
 */
const HEAD_ONLY: { selector: string; why: string }[] = [
    { selector: 'header nav a[href="/curation/series"]', why: "#150: the curator header's Series link" },
    // The series header's first child, its only <p>, so nothing after it in the header changes its path.
    { selector: 'main > article > header > p:first-child:has(> a[href="/work"])', why: "#173 (B4): the series page's All work link above the title" },
    { selector: '[data-home-carousel] > p[aria-live]', why: "#4: Home's carousel's visually hidden live region" },
    // After Enter the series, its last child, so nothing before it in the story changes its path.
    { selector: '[data-chrome-region="story"] > div > a[href="/work"]:last-child', why: "#4 (B7): Home's All bodies of work link after Enter the series" },
    // #180's A8, the curation Inbox screen. Each is new beside what next has, which stays where it was: the poll's live
    // region straight in the page, as the watcher strip is; the filters and the bulk form above the list's rows, which
    // stay in the list's own lists; and in each row, its checkbox's column beside the link and its age under the ID.
    { selector: 'div:has(> main > #inbox-list) > [role="status"][aria-label="Inbox updates"]', why: "#180 (A8): the Inbox poll's live region, empty until there's news" },
    { selector: '#inbox-list > form[role="search"]', why: "#180 (A8): the Inbox's Status and Type filters" },
    { selector: '#inbox-list > form#inbox-bulk', why: "#180 (A8): the Inbox's bulk Decide later and Leave unassigned" },
    { selector: '#inbox-list li > label:has(> input[type="checkbox"][form="inbox-bulk"])', why: "#180 (A8): an Inbox row's bulk checkbox, in its own column" },
    { selector: '#inbox-list li > span[aria-hidden="true"]:first-child', why: "#180 (A8): the empty checkbox column of a row no bulk action takes" },
    { selector: '#inbox-list a[data-row] > span > span:has(> time)', why: "#180 (A8): an Inbox row's age, as \"Opened 3 h ago\"" },
];

/**
 * #171 (B3): Work's entries are heading links. Today each entry is one link round the cover, the h2, the statement and
 * the count. In the head the entry is a box, and its link is the title, the h2's one child, whose ::after stretches
 * over the whole entry as its target and draws its ring. Two rules keep the rest of the entry compared exactly, both
 * on /work only:
 * - RETAGGED: the head's entry box is walked as the `a` it replaces, so the cover, the copy and everything under them
 *   keep today's paths, and their styles and boxes are compared as before;
 * - FOLDED: the title link is left out of both walks, with no layout change, since it adds no element the base had.
 *   Its own paint must equal its h2's (test/helpers/parityWalk.ts's FOLD_PAINT): the same ink and type, no margin or padding, and no
 *   fill, line, outline, band, decoration, clip, mask or compositing of its own. Its ::before and ::after are read
 *   too, and paint nothing at rest. The ::after is the target, and in `work-focus` the ring, pinned to its values in
 *   Dark as a departure of its own (B3's review, 2). work.spec.ts checks the target and the ring in every theme.
 */
const WORK_ENTRY = 'main > ul > li > div:has(> div > h2 > a)';
const RETAGGED: { url: string; selector: string; as: string; why: string }[] = [
    { url: '/work', selector: WORK_ENTRY, as: 'a', why: "#171 (B3): Work's entry box, the stretched link's, where today's entry link was" },
];
const FOLDED: { url: string; selector: string; why: string; focus?: { page: string; after: Record<string, string>; why: string } }[] = [
    {
        url: '/work',
        selector: `${WORK_ENTRY} > div > h2 > a`,
        why: "#171 (B3): Work's title link, its h2's one child, painting as the h2",
        // The focused link's ::after draws the token inset, in Dark's white and black: the issue's "with the focus ring
        // inset", where today's ring was the entry link's own, outside it (WORK_ENTRIES' work-focus departure).
        focus: {
            page: 'work-focus',
            after: { 'outline-style': 'solid', 'outline-width': '3px', 'outline-offset': '-3px', 'outline-color': 'rgb(255, 255, 255)', 'box-shadow': 'rgb(0, 0, 0) 0px 0px 0px 6px inset' },
            why: "#171 (B3): a focused Work entry's ring, inset on its title link's ::after",
        },
    },
    // The Viewer heading's title (#175), on each Viewer url: the h1 is named "{series}, photograph N of T" by its
    // aria-label, and the title it shows is a span hidden from screen readers, the h1's one child, where the base had
    // the title as the h1's own text. Folded, so it must paint as its h1 does. The modal pairs open from the series
    // page, so that url carries it too; nothing matches there until the Viewer opens.
    ...[`${series}/photo/${HOME_OPENING}`, `${series}/photo/${HOME_PHOTO_IDS[1]}`, series].map((url) => ({
        url,
        selector: '[data-surface="viewer"] header h1 > span[aria-hidden="true"]:only-child',
        why: "#175: the Viewer heading's shown title, hidden from screen readers under its aria-label",
    })),
];
const retagFor = (pair: Pair) => RETAGGED.filter((entry) => entry.url === pair.url).map(({ selector, as }) => ({ selector, as }));
const foldFor = (pair: Pair) =>
    FOLDED.filter((entry) => entry.url === pair.url).map(({ selector, focus }) => ({ selector, ...(focus && (focus.page === pair.name || focus.page === pair.stateOf) && { focused: { '::after': focus.after } }) }));

/**
 * #171 (B3), the two sanctioned departures on Work's entries, each named per entry (the visitor fixture has two
 * series, e2e/support/homeFixture.ts): the entry box is `position: relative`, the containing block its title link's
 * ::after stretches over, where today's static link was; and a focused entry's ring is no longer the entry box's own,
 * outside it, but the title link's, inset on its ::after (the issue's "with the focus ring inset", in every theme).
 * Nothing moves: every box, and every other style, is compared exactly.
 */
const WORK_ENTRIES: Allowance[] = [1, 2].flatMap((n): Allowance[] => {
    const selector = `main > ul > li:nth-of-type(${n}) > :first-child`;
    return [
        { page: 'work', selector, properties: ['position'], why: "#171 (B3): Work's entry box holds its title link's stretched target" },
        ...(n === 1
            ? [{ page: 'work-focus', selector, properties: ['outline-color', 'outline-style', 'outline-width', 'outline-offset', 'box-shadow'], why: "#171 (B3): a focused Work entry's ring is inset on its title link's ::after" }]
            : []),
    ];
});

/**
 * #171, Work's entry reveal, a sanctioned departure: keyboard focus on an entry's link brings the whole entry into
 * view in the frame after the focus, within html's scroll paddings (components/work/WorkEntryLink.tsx). In
 * work-focus at 1440 by 900 the first entry is 633 px tall, 645 px with its ring, so it fits the 676 px room (the
 * screen less the 96 and 128 px paddings), but its foot is at 932, past the screen: the reveal scrolls it to the
 * room's foot at 772, exactly 160 px. So every box on the page is the base's moved up exactly 160 px, with no
 * tolerance band. Only no box at all, a rect of all zeros in both builds, has nothing to scroll and must stay exactly
 * where the base has it: `body>div:nth-of-type(1)`, Next's hidden metadata wrapper (`<div hidden>`, display: none,
 * 0 0 0 0), is the one here. A zero-size box at a real position is in the page's flow and scrolls with it, so it takes
 * the shift too: each entry's empty <picture> and its two <source>s, and next-route-announcer at the page's foot (CI
 * run 42346229076; test/helpers/parityShift.ts). Any move of 159 or 161 px, a fraction off, or none fails the row
 * (the self-tests below, and test/parityShift.test.ts), and every style is still compared exactly. Only in the two
 * routes with JavaScript, at 1440: with none nothing reveals, and at 1024 and 390 the entry needs no scroll, so those
 * rows stay exact.
 *
 * The ring is WORK_ENTRIES' departure above, inset on the title link's ::after. Measured at 1x and 2x in both routes
 * (CI run 42337453713, e2e/themes/work-focus-probe.spec.ts on a test branch), its light band is 19.85:1 against the
 * ground outside it and at least 5.26:1 against the cover inside it (19.85:1 where the inside is the ground), so it
 * keeps at least 3:1 on both sides, as the base's ring does. The reveal stays under test: work.spec.ts's Tab and
 * Shift+Tab test, and the self-tests below.
 */
const WORK_REVEAL_SCROLL = 160;
const SCRIPTED_ROUTES = ['System on a dark device', 'a stored `dark`'] as const;
const WORK_REVEAL: Allowance[] = [
    {
        page: 'work-focus',
        width: 1440,
        routes: SCRIPTED_ROUTES,
        selector: 'body',
        subtree: true,
        shift: { x: 0, y: -WORK_REVEAL_SCROLL },
        why: "#171: keyboard focus on Work's first entry scrolls it 160 px into the room between html's scroll paddings",
    },
];

/**
 * #179, the portrait's frame (B1): 4:3 stacked under a cap of min(45svh, 28rem), and 4:5 side by side, from the
 * refined #12's mockup, where today's About sets a height (clamp(250px, 42svh, 380px) stacked, 420 px wide). Every
 * paint, type and style in About stays exact; only boxes in main move, and the page's height with them. At 390 the
 * photo is 105 px shorter and everything under it rises with it. At 1024 the figure keeps to its own height in the
 * grid row, 22 px shorter. At 1440 the photo is 207 px taller, and the statement, centred in the row, moves down half
 * that. Each width's bound sits just above what it measured.
 */
const ABOUT_FRAME: Allowance[] = (
    [
        [390, 110],
        [1024, 25],
        [1440, 210],
    ] as const
).flatMap(([width, maxDelta]): Allowance[] => {
    const why = "#179: About's portrait frame, 4:3 stacked and 4:5 side by side";
    return [
        { page: 'about', width, selector: 'body', maxDelta, why },
        { page: 'about', width, selector: 'body > next-route-announcer', maxDelta, why },
        { page: 'about', width, selector: 'main[data-surface="about"]', maxDelta, subtree: true, why },
    ];
});

/**
 * #179's frame again, in About's link hover at 390 (B1's CI). Playwright's hover scrolls its link into view when it's
 * below the fold. In the base, the 354 px photo puts the statement's first link under the fold at 844, so the hover
 * scrolls the page 159 px. In the head, the 4:3 photo is 105 px shorter, the link is in view already, and nothing
 * scrolls. So every box, the nav's too, sits 159 px apart in the viewport: 54 px below the photo, where the shorter
 * frame takes back 105. Only this state, and only at 390: its focus twin focuses without scrolling, and at 1024 and
 * 1440 the hover passes under ABOUT_FRAME's bounds. Every paint, type and style is still compared exactly.
 *
 * Signed off by the coordinator, 2026-11-07: not a new departure. It's ABOUT_FRAME's sanctioned 4:3 frame, seen
 * through Playwright's hover scrolling the link into view; in the head the link is already in view, so nothing
 * scrolls. It applies only to the hover state at 390, and every paint, type and style is still compared exactly.
 */
const ABOUT_LINK_SCROLL: Allowance[] = ((): Allowance[] => {
    const why = "#179: About's portrait frame, 4:3 stacked; the base's hover scrolls to the link, the head's doesn't";
    const at = { page: 'about-link-hover', width: 390, maxDelta: 165, why };
    return [
        { ...at, selector: 'body' },
        { ...at, selector: 'body > next-route-announcer' },
        { ...at, selector: 'nav[aria-label="Primary"]', subtree: true },
        { ...at, selector: 'main[data-surface="about"]', subtree: true },
    ];
})();

/**
 * #180's A8, the curation Inbox screen: a row a bulk action can take is a grid of two columns, its checkbox's and its
 * link's, where next's row is a plain list item. The checkbox's column is HEAD_ONLY's, and its track is as wide as what
 * it holds, so with it taken out the link sits exactly where next's does: every box and every other style is compared
 * exactly. Only the row's own `display` departs, list-item to grid, and the ::marker that only a list item has goes
 * with it (test/helpers/parityWalk.ts). Every item openInboxItems() opens needs judgment, so each is a row of the
 * list's one ul, and every row has the column, an empty one for the missing source.
 */
const INBOX_PICK_ROWS: Allowance[] = Array.from({ length: OPENED_INBOX_ITEMS }, (_, index): Allowance => ({
    page: 'inbox',
    selector: `#inbox-list > ul > li:nth-of-type(${index + 1})`,
    properties: ['display'],
    why: "#180 (A8): an Inbox row is a grid of its checkbox's column and its link",
}));

/**
 * A sanctioned departure (#175): Zoom is `clamp(fitted, 2 * fitted, largest file)`, where the base zoomed every
 * photograph to its largest file. HOME_OPENING is a 1600 by 2400 portrait, so the base's zoomed print is 1600 by 2400
 * at every size, and the head's about twice its fitted width. Only the zoomed print's own boxes may differ, by up to
 * that print's height; their styles are still compared. The zoomed stage is capped at the stage's height, which both
 * builds' prints overflow at the gate's three sizes, so the stage, the moves and the reading area must still match.
 */
const VIEWER_ZOOM: Allowance[] = [
    ...['figure', 'figure > picture', 'figure img'].map(
        (part): Allowance => ({
            page: 'viewer-zoomed',
            selector: `[data-surface="viewer"] [data-zoomed] ${part}`,
            maxDelta: 2400,
            why: '#175: Zoom is clamp(fitted, 2 * fitted, the largest file)',
        }),
    ),
    // The zoomed print's two <source>s, AVIF and WebP, on desktop and tablet on the routes with JavaScript, where Zoom
    // applies, as a sanctioned departure: they paint nothing, and their boxes follow the img's, which the
    // entries above allow. One entry each, since a selector resolves to one path.
    ...[1440, 1024].flatMap((width) =>
        [1, 2].map(
            (n): Allowance => ({
                page: 'viewer-zoomed',
                width,
                routes: SCRIPTED_ROUTES,
                selector: `[data-surface="viewer"] [data-zoomed] figure > picture > source:nth-of-type(${n})`,
                maxDelta: 2400,
                why: "#175: Zoom's sources follow the zoomed img",
            }),
        ),
    ),
];

const ALLOWANCES: Allowance[] = [
    ...WORK_ENTRIES,
    ...WORK_REVEAL,
    ...ABOUT_FRAME,
    ...ABOUT_LINK_SCROLL,
    // Drawn on the rules around the row (the design review's P2-1): its own separator takes the outline's colour.
    { page: 'inbox', selector: 'main ul a[aria-current="true"]', properties: ['box-shadow', 'border-bottom-color'], why: "P2-8: the Inbox's selected row's outline" },
    { page: 'inbox', selector: 'header nav a[aria-current="page"]', properties: ['box-shadow'], why: "P2-8: the Inbox's selected tab's outline" },
    { page: 'publish', selector: 'header nav a[aria-current="page"]', properties: ['box-shadow'], why: "P2-8: Publish's selected tab's outline" },
    ...INDEPENDENT_PANELS,
    // #4's failure copy (v2.0.0): "Couldn't load photograph 04 of 04" is 2.2 px narrower than "Photograph 04 of 04 couldn't load.".
    ...['[data-chrome-region="sequence"] > div', '[data-chrome-region="sequence"] [role="status"]', '[data-chrome-region="sequence"] [role="status"] > p'].map((selector): Allowance => ({
        page: 'home-failure',
        selector,
        maxDelta: 4,
        why: "#4: the failure notice's new copy",
    })),
    ...INBOX_PICK_ROWS,
    // On a phone the failure notice lifts the copy: the title's top is 54.98% down the stage at 390, where today's fixed
    // phone wash holds the title at only about 3.2:1 over a white photograph. There Dark's wash follows the copy
    // (badgePlace.ts's copyAboveDarkWash()), an AA fix, so Home's scrim, the walk's
    // body>main:nth-of-type(1)>div:nth-of-type(1)>div:nth-of-type(3), takes the gradient that follows the copy.
    // home-failure-hover is a state of home-failure (stateOf), so allowancesFor() gives it this one too.
    {
        page: 'home-failure',
        width: 390,
        selector: '[data-home-vignette]',
        properties: ['background-image'],
        why: "#4: with the failure notice the copy rises above Dark's fixed phone wash, so the wash follows it (AA)",
    },
    // #150's Series makes three screens in the header, which may wrap to a second row on a phone.
    ...(['inbox', 'publish'] as const).map((page): Allowance => ({ page, width: 390, selector: 'header nav', properties: ['flex-wrap'], why: "#150: the curator header's screens wrap on a phone" })),
    ...VIEWER_ZOOM,
    // The failed box scrolls a long alt or enlarged text inside itself (overflow-y: auto, which makes overflow-x auto).
    { page: 'viewer-missing', selector: '[data-surface="viewer"] [data-photo="unavailable"]', properties: ['overflow-x', 'overflow-y'], why: '#175: the failed box scrolls its alt' },
];
/** A state's own allowances, and those of the page it's a state of. On one of the gate's routes, or on any when it's left out. */
const allowancesFor = (pair: Pair, width: number, route?: string) =>
    ALLOWANCES.filter(
        (entry) =>
            (entry.page === pair.name || entry.page === pair.stateOf) &&
            (entry.width === undefined || entry.width === width) &&
            (route === undefined || entry.routes === undefined || entry.routes.includes(route)),
    );

/**
 * The box allowances for `pair` at `width` on `route`, by the paths they resolved to in the base's walk: the most a box
 * may move, and the exact move a box must make. A subtree allowance covers the element and every path under it. A path
 * that two allowances name (a state's own and its page's) takes the larger move.
 */
function geometryFor(pair: Pair, width: number, route: string, base: Walk): { allowances: Record<string, number>; shifts: Record<string, readonly [number, number]> } {
    const allowances: Record<string, number> = {};
    const shifts: Record<string, readonly [number, number]> = {};
    for (const entry of allowancesFor(pair, width, route).filter((candidate) => base.resolved[candidate.selector])) {
        const root = base.resolved[entry.selector];
        const paths = entry.subtree ? base.elements.map((element) => element.path).filter((path) => path === root || path.startsWith(`${root}>`)) : [root];
        for (const path of paths) {
            if (entry.maxDelta !== undefined) allowances[path] = Math.max(allowances[path] ?? 0, entry.maxDelta);
            if (entry.shift) shifts[path] = [entry.shift.x, entry.shift.y];
        }
    }
    return { allowances, shifts };
}

interface Walked2 {
    walk: Walk;
    /** The waits that timed out on this load: any fails the row. */
    timedOut: string[];
    /** What painted: `<html data-theme>` once the page settled. */
    theme: string | null;
    /** Next's bare error shell: `<html id="__next_error__">` with nothing in its body but scripts and an empty hidden div. */
    shell: boolean;
    /** The Viewer's details list rows, for a `cameraRows` pair, null where a dt or dd is missing; empty for any other. */
    facts: (FactRow | null)[];
}

/**
 * The gate's own check that the head painted Dark (the remap's review, L1): until Black's layer lands, Black computes
 * the same styles as Dark, so a route sent to `black` would otherwise pass every comparison. Its failing lines, or none.
 * One page carries no theme: the error page with no JavaScript, which is Next's own error shell, a bare
 * `<html id="__next_error__">` that never renders the root layout. A missing theme passes only when both builds serve
 * that shell, and the comparison with the base is the check there. Any other page with no theme fails.
 */
const paintsDark = (walked: Walked2, base?: Walked2): string[] =>
    walked.theme === 'dark' || (walked.theme === null && walked.shell && base?.theme === null && base.shell) ? [] : [`painted ${walked.theme ?? 'nothing'}, not dark`];

/** A walk of `pair` in one build: every element's computed style and box, and the tokens, from a fresh settled load. */
async function styles(
    origin: string,
    stored: string,
    pair: Pair,
    viewport: { width: number; height: number },
    tag: string,
    { js = true, session, motion, stripTheme = false }: { js?: boolean; session?: string; motion?: Motion; stripTheme?: boolean } = {},
): Promise<Walked2> {
    const head = !tag.startsWith('base');
    // The curator's head takes the control out of the layout, as no JavaScript does, since the base's header had none.
    const css = [
        pair.addsControl && head ? '[data-theme-control]{display:none!important}' : '',
        head ? `${HEAD_ONLY.map((entry) => entry.selector).join(',')}{display:none!important}` : '',
        pair.headStyle && head ? pair.headStyle : '',
    ].join('');
    const { context, page, timedOut } = await open(origin, stored, pair, viewport, 1, css, { js, session, motion, pin: true });
    try {
        const selectors = allowancesFor(pair, viewport.width).map((entry) => entry.selector);
        // The self-test's page with its theme taken off, to show a missing theme fails anywhere but the error shell.
        if (stripTheme) await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
        const painted = await page.evaluate(() => ({
            theme: document.documentElement.getAttribute('data-theme'),
            shell:
                document.documentElement.id === '__next_error__' &&
                // Next's shell holds its scripts, some inline, and one empty hidden div for its Suspense markers. Nothing
                // else in it may carry text.
                [...document.body.children].every((child) => child.localName === 'script' || (child.localName === 'div' && child.hasAttribute('hidden') && child.textContent?.trim() === '')) &&
                [...document.body.childNodes].every((node) => node.nodeType !== Node.TEXT_NODE || node.textContent?.trim() === ''),
        }));
        // Without JavaScript, React's late segments wait at the end of the body. Where they go is content no-JS never
        // shows, so they're put there in both builds, and the walk compares the page as it's built, not how its payload
        // split (the Inbox's rows stream one by one). Then the details list is read, then the walk, so both
        // reads see the same DOM.
        if (!js) await page.evaluate(completeHiddenSegments);
        // The base's Camera make row, its first, which the head merged into Camera (cameraRows); the rest keep their paths.
        const baseOnly = pair.cameraRows && !head ? [`${FACT_ROWS}:first-of-type`] : [];
        // Read as the text is, untrimmed, with a row that hasn't exactly one dt and one dd as null (readFactRows).
        const facts: (FactRow | null)[] = pair.cameraRows ? await page.evaluate(readFactRows, FACT_ROWS) : [];
        const leaveOut = [...HEAD_ONLY, ...(pair.leaveOut ?? [])].map((entry) => entry.selector);
        return { walk: await walk(page, selectors, [...leaveOut, ...baseOnly], { retag: retagFor(pair), fold: foldFor(pair) }), timedOut, ...painted, facts };
    } finally {
        await context.close();
    }
}

/** Records one comparison, its failing lines and every box delta, and returns the failing lines. */
function judge(label: string, width: number, c: Comparison, timedOut: string[] = []): string[] {
    const failing = [...failures(c), ...timedOut.map((wait) => `a wait timed out: ${wait}`)];
    fs.appendFileSync(STYLE_ROWS, `| ${label} | ${width} | ${c.structural.length} | ${c.styles.length} | ${c.tokens.length} | ${c.geometry.length} | ${c.deltas.length} | ${+c.largest.toFixed(3)} | ${timedOut.length ? timedOut.join(', ') : ''} | ${c.added.length} |\n`);
    const section = (title: string, lines: string[]) => (lines.length ? `\n#### ${title}\n\n${lines.map((line) => `- \`${line}\``).join('\n')}\n` : '');
    const details =
        section('Structure', c.structural) +
        section('Styles', c.styles) +
        section('Tokens', c.tokens) +
        section('Boxes over their allowance', c.geometry) +
        section('Every box delta', c.deltas) +
        section('Waits that timed out', timedOut) +
        section('Tokens new in the head', c.added) +
        section('Sanctioned departures', c.sanctioned);
    if (details) fs.appendFileSync(STYLE_DETAILS, `\n### ${label}, ${width}\n${details}`);
    return failing;
}

/**
 * Waits, up to 30 s, until `origin`'s About carries its portrait's LQIP, and says whether it did. The server encodes it
 * last, after every variant, in the background (lib/siteConfig/portraitVariants.ts), so one just started can serve
 * About, and Home's intro, which shows the portrait too, without it for a while after the warm-up's load. A failed
 * test starts the worker again, and the servers with it, so the next pair would walk one build with the LQIP and the
 * other without it (B3's CI, and B1's). A wait that runs out fails the gate's rows, as any other wait does. Each fetch
 * gets 5 s, so a hung one can't hold the wait past its 30.
 */
async function portraitWarm(origin: string): Promise<boolean> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        const html = await fetch(`${origin}/about`, { signal: AbortSignal.timeout(5_000) }).then((response) => response.text(), () => '');
        if (html.includes('data:image/webp;base64,')) return true;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
}

/**
 * The properties the gate sanctions for `pair` at `width` on `route`, by the path each allowance resolved to in the base's
 * walk. The route is required, so no caller can take an allowance limited to other routes.
 * A path that two allowances name takes both their properties: a state takes its page's too, as work-focus does
 * work's `position` on the entry box its own ring departure names (B3's CI).
 */
function sanctionedFor(pair: Pair, width: number, base: Walk, route: string): Record<string, string[]> {
    const sanctioned: Record<string, string[]> = {};
    for (const entry of allowancesFor(pair, width, route).filter((candidate) => candidate.properties && base.resolved[candidate.selector])) {
        const path = base.resolved[entry.selector];
        sanctioned[path] = [...new Set([...(sanctioned[path] ?? []), ...entry.properties!])];
    }
    return sanctioned;
}

/**
 * The gate, at each size: Dark in the head against the base, element by element, in all three of Dark's routes.
 * System on a dark device and today's stored `dark` against the base on its stored `dark`; no JavaScript against the
 * base without it. A wait that times out in either build fails the row, and a head with JavaScript that doesn't
 * hydrate fails it too (its hydration wait is one of them). Home's intro has a fourth route: motion allowed, held in
 * its loading phase, System against the base's stored `dark`, where the grain and the ripples are.
 */
async function gate(pair: Pair, origins: { base: string; head: string }, cookies?: { base: string; head: string }, { portrait = false }: { portrait?: boolean } = {}) {
    // One throwaway load in each build first: a server derives some things on first ask (About's portrait LQIP), so
    // the first walk of a page could catch one build before it has them.
    for (const [origin, session] of [[origins.base, cookies?.base], [origins.head, cookies?.head]] as const) {
        await styles(origin, 'dark', pair, VIEWPORTS.desktop, 'warm-up', { session });
    }
    // On the visitor site, every page waits for the portrait's LQIP in both builds, since a restarted worker can come
    // to any of them first.
    const [baseWarm, headWarm] = portrait ? await Promise.all([portraitWarm(origins.base), portraitWarm(origins.head)]) : [true, true];
    const unwarmed = [...(baseWarm ? [] : ['portrait LQIP (base)']), ...(headWarm ? [] : ['portrait LQIP (head)'])];
    for (const [size, viewport] of Object.entries(GATE_VIEWPORTS)) {
        const base = await styles(origins.base, 'dark', pair, viewport, 'base', { session: cookies?.base });
        const baseNoJs = await styles(origins.base, '', pair, viewport, 'base', { js: false, session: cookies?.base });
        for (const [route, stored, js, against] of [
            ['System on a dark device', '', true, base],
            ['a stored `dark`', 'dark', true, base],
            ['no JavaScript', '', false, baseNoJs],
        ] as const) {
            const head = await styles(origins.head, stored, pair, viewport, 'head', { js, session: cookies?.head });
            const { allowances, shifts } = geometryFor(pair, viewport.width, route, against.walk);
            const sanctioned = sanctionedFor(pair, viewport.width, against.walk, route);
            const timedOut = [...unwarmed, ...against.timedOut.map((wait) => `${wait} (base)`), ...head.timedOut.map((wait) => `${wait} (head)`)];
            const comparison = compare(against.walk, head.walk, allowances, sanctioned, shifts);
            // The details list's departure (#175): Camera make merged into Camera, and the three unit rows. A failing
            // line is structural, so the report counts and prints it; the sanction is recorded only when none fails.
            if (pair.cameraRows) {
                const camera = cameraRowDeparture(against.facts, head.facts);
                comparison.structural.push(...camera.failing.map((line) => `the details list: ${line}`));
                if (camera.failing.length === 0) comparison.sanctioned.push(...camera.record.map((line) => `#175, the details list: ${line}`));
            }
            const failing = [...judge(`${pair.name}, ${route}`, viewport.width, comparison, timedOut), ...paintsDark(head, against)];
            expect.soft(failing, `${pair.name} at ${size} ${viewport.width}, ${route}: computed style against the base`).toEqual([]);
        }
        if (pair.intro) {
            const route = 'motion allowed, in the loading phase';
            const against = await styles(origins.base, 'dark', pair, viewport, 'base', { motion: LOADING });
            const head = await styles(origins.head, '', pair, viewport, 'head', { motion: LOADING });
            const timedOut = [...unwarmed, ...against.timedOut.map((wait) => `${wait} (base)`), ...head.timedOut.map((wait) => `${wait} (head)`)];
            const failing = [...judge(`${pair.name}, ${route}`, viewport.width, compare(against.walk, head.walk), timedOut), ...paintsDark(head, against)];
            expect.soft(failing, `${pair.name} at ${size} ${viewport.width}, ${route}: computed style against the base`).toEqual([]);
        }
    }
}

/**
 * The gate (`gate`, computed style), then the pixel report (both passes, at every size and scale): not a gate, since
 * the base doesn't render the same pixels twice, but recorded, with the base against itself, for what only pixels show.
 */
function parity(group: string, pairs: Pair[], origins: () => { base: string; head: string }, options: { legacy?: boolean; session?: () => { base: string; head: string }; portrait?: boolean } = {}) {
    for (const pair of pairs) {
        test(`${group}: ${pair.name}`, async () => {
            const { base, head } = origins();
            const cookies = pair.session ? options.session!() : undefined;
            await gate(pair, { base, head }, cookies, { portrait: options.portrait });
            if (pair.gateOnly) return;
            for (const [size, viewport] of Object.entries(VIEWPORTS)) {
                for (const scale of SCALES) {
                    const name = `${pair.name}-${viewport.width}-${scale}x`;
                    const before = await shoot(base, 'dark', pair, viewport, scale, 'base', cookies?.base);
                    row(`${pair.name}, the base against itself`, size, viewport.width, scale, await diff(before, await shoot(base, 'dark', pair, viewport, scale, 'base-again', cookies?.base), scale, `${name}-base-against-itself`));
                    row(pair.name, size, viewport.width, scale, await diff(before, await shoot(head, 'dark', pair, viewport, scale, 'head', cookies?.head), scale, name));
                    if (options.legacy && scale === 1) {
                        row(`${pair.name}, head on stored \`charcoal\``, size, viewport.width, 1, await diff(before, await shoot(head, 'charcoal', pair, viewport, scale, 'head-legacy-charcoal', cookies?.head), scale, `${name}-legacy-charcoal`));
                    }
                }
            }
        });
    }
}

/** The base checkout's commit, for the report. */
function baseCommit(): string {
    const head = spawnSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: BASE, encoding: 'utf8' });
    return head.status === 0 ? head.stdout.trim() : String(BASE);
}

// --- Fixtures and rounds -----------------------------------------------------------------------------------------

let temp = '';
let siteConfig = '';
let library = '';
let visitorRoot = '';
let inbox: InboxFixture | undefined;
let secrets: TestCuratorSecrets | undefined;
const port = (index: number): number | null => pinned[index] ?? null;

test.beforeAll(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'themes-parity-'));
    siteConfig = path.join(temp, 'site-config');
    library = path.join(temp, 'library');
    fs.mkdirSync(siteConfig);
    fs.mkdirSync(library);
    const written = spawnSync(process.execPath, [path.join(HEAD, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'e2e/support/write-site-config.ts', siteConfig], { cwd: HEAD, encoding: 'utf8' });
    if (written.status !== 0) throw new Error(`write-site-config failed: ${written.stderr}`);
    visitorRoot = path.join(temp, 'visitor');
    await publishHomeFixture(visitorRoot);
    browser = await chromium.launch();
});

test.afterAll(async () => {
    await browser?.close();
    await inbox?.cleanup();
    secrets?.cleanup();
    // Nothing is deleted on a machine with a Trash: the run's fixtures go there. CI's runner is thrown away whole.
    const trash = path.join(os.homedir(), '.Trash');
    try {
        if (temp && fs.existsSync(trash)) fs.renameSync(temp, path.join(trash, `${path.basename(temp)}-${Date.now()}`));
        else if (temp && process.env.CI) fs.rmSync(temp, { recursive: true, force: true });
    } catch {
        // On another volume than the Trash (EXDEV): it stays where it is.
    }
    const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    fs.writeFileSync(
        path.join(OUT, 'dark-parity.md'),
        [
            '# Dark against the base',
            '',
            `Base: \`${baseCommit()}\`.`,
            '',
            '## The gate: computed style',
            '',
            "Every element under body (and in the curator's preview frame), matched by tag and nth-of-type, its ::before and ::after, and the custom properties on :root and body, in the head's Dark against the base, at 1440, 1024 and 390, in Dark's three routes, with Home's intro also in its loading phase with motion allowed, and hover and focus on the nav links, Home's controls, About's links and the Inbox's rows and buttons. The theme control and today's toggle are left out with their subtrees; the curator's head takes its control out of the layout, as no JavaScript does. Structure, styles, base tokens, any box that moved (beyond the one named allowance) and any wait that timed out fail; every box delta and the tokens new in the head are listed below.",
            '',
            `Left out as new in the head, taken out of its layout and of both walks: ${HEAD_ONLY.map((entry) => `\`${entry.selector}\` (${entry.why})`).join('; ')}.`,
            '',
            `Walked under the tag it replaces, so its subtree keeps the base's paths: ${RETAGGED.map((entry) => `\`${entry.selector}\` as \`${entry.as}\` on ${entry.url} (${entry.why})`).join('; ')}.`,
            '',
            `Left out of both walks in place, its own paint and its pseudo-elements' checked against its parent's: ${FOLDED.map((entry) => `\`${entry.selector}\` on ${entry.url} (${entry.why})${entry.focus ? `, with its focused ::after pinned in ${entry.focus.page} to ${Object.entries(entry.focus.after).map(([name, value]) => `${name}: ${value}`).join(', ')} (${entry.focus.why})` : ''}`).join('; ')}.`,
            '',
            '| Page, route | Width | Structure | Styles | Tokens | Boxes over allowance | Box deltas | Largest delta (px) | Waits timed out | New tokens |',
            '|---|---|---|---|---|---|---|---|---|---|',
            read(STYLE_ROWS).trimEnd(),
            '',
            read(STYLE_DETAILS) ? `## The gate's details\n${read(STYLE_DETAILS)}` : '',
            '',
            '## The pixel report (not a gate)',
            '',
            `Chrome (pass 1, every photograph taken out, or a checkerboard on a page with glass): pixels differing outside the theme controls' boxes. Photo (pass 2, only the photographs): the largest channel step inside their boxes; up to ${PHOTO_STEP} is invisible in a photograph. Compositing: photographs whose opacity, filter or blend (or an ancestor's) differ. The base against itself shows what the base doesn't repeat.`,
            '',
            '| Page | Viewport | Scale | Chrome pixels | Chrome max step | Photo max step | Compositing diffs | Where (chrome) |',
            '|---|---|---|---|---|---|---|---|',
            read(ROWS).trimEnd(),
            read(RECTS) ? `\n## Boxes, unrounded (x y width height, CSS px)\n\n| Page | Viewport | Shot | Selector | Box |\n|---|---|---|---|---|\n${read(RECTS)}` : '',
        ].join('\n'),
    );
});

test.describe('the visitor site', () => {
    const servers: Server[] = [];
    let visitor = { base: '', head: '' };

    // Both builds on the published Home fixture, so every visitor pair is the catalog site in both. The note above
    // CURATOR says why the legacy servers, on a data root with nothing published, aren't started any more.
    test.beforeAll(async () => {
        const catalog = { PHOTOGRAPHY_LIBRARY_DIR: library, PHOTOGRAPHY_SITE_CONFIG_DIR: siteConfig, PHOTOGRAPHY_DATA_DIR: visitorRoot };
        const [a, b] = [port(0), port(1)];
        const started = await Promise.all([serve(BASE!, a, catalog, '/api/ready'), serve(HEAD, b, catalog, '/api/ready')]);
        servers.push(...started);
        visitor = { base: started[0].origin, head: started[1].origin };
    });

    test.afterAll(async () => {
        await Promise.all(servers.map((server) => server.stop()));
    });

    parity('visitor', VISITOR, () => visitor, { legacy: true, portrait: true });

    // Once, for the record (R2-P2-2): with the scrim on a layer of its own in both builds, does Home's old raster step
    // with its chrome show?
    test('diagnosis: Home with its chrome, with the scrim on its own layer', async () => {
        const pair: Pair = {
            name: 'home-chrome-will-change',
            url: '/',
            act: async (page) => {
                await page.addStyleTag({ content: '[class*=vignette]{will-change:transform}' });
                await revealChrome(page);
            },
        };
        const viewport = VIEWPORTS.desktop;
        const result = await diff(await shoot(visitor.base, 'dark', pair, viewport, 1, 'base'), await shoot(visitor.head, 'dark', pair, viewport, 1, 'head'), 1, 'home-chrome-will-change');
        row('home-chrome, the scrim on its own layer (diagnosis)', 'desktop', 1440, 1, result);
        test.info().annotations.push({ type: 'diagnosis', description: `${result.count} pixels differ, max step ${result.maxStep}` });
    });

    // The gate sees what it claims to: each of these, injected into the head, must fail it. Recorded, and asserted.
    // The Viewer heading's shown title, longer in the head; the base has no such span, so nothing changes there.
    const changeViewerTitle = (page: Page) =>
        page.evaluate(() => {
            for (const span of document.querySelectorAll('[data-surface="viewer"] header h1 > span[aria-hidden="true"]')) span.append(' at dusk');
        });
    const hoverNavLink = (page: Page) => page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Work', exact: true }).hover();
    for (const [name, url, headStyle, act, motion, ...rest] of [
        ["Home's scrim, +1 on one channel", '/', '[class*="vignette"]{background:linear-gradient(90deg,rgb(9 10 9/.9) 0%,rgb(9 10 9/.46) 38%,rgb(9 10 9/.08) 70%)!important}', revealChrome, undefined],
        ['the glass blur at 13px', '/work', ':root{--gah-glass-blur:13px!important}', undefined, undefined],
        ["a photograph's opacity at .96", '/work', 'main img{opacity:.96!important}', undefined, undefined],
        ['--gah-ink, +1 on one channel', '/work', ':root{--gah-ink:#f4f6f6!important}', undefined, undefined],
        // The radius is the frame's, the photo's material (spec §2), so the cover's frame on a series page.
        ["a photograph's corners square", series, '[class*="coverFrame"]{border-radius:0!important}', undefined, undefined],
        // About's own link labels, under main, and not the nav's (#122's Delta 3 nit): only the labels may differ.
        ["About's link underlines red", '/about', 'main a [class*="label"]{text-decoration-color:red!important}', undefined, undefined, { within: '>main:nth-of-type(', property: 'text-decoration-color' }],
        ['a hovered nav link white', '/work', 'nav a:hover{color:#fff!important}', hoverNavLink, undefined],
        ["the intro's grain at .12, with motion allowed", '/', '[class*="grainTexture"]{opacity:.12!important}', undefined, LOADING],
        ["Home's control hover, with motion allowed", '/', '[class*="_button"]:hover{color:#fff!important;background:rgb(255 0 0/.5)!important}', async (page: Page) => {
            await revealChrome(page);
            await hoverOn(homeNext(page));
        }, SETTLED],
        // The title link Work folds into its h2 (B3's review, 2 and 3): a paint on its ::after at rest, a padding or a
        // border of its own, must fail as a style, though neither element is walked. Each must be seen as itself, not
        // as any other fold line (B3's CI: a reset's `border: 0 solid` failed every fold, and these passed on it).
        ["a folded link's ::after painting at rest", '/work', 'main ul li h2 a::after{background:rgb(255 0 0/.5)!important}', undefined, undefined, { seen: '(folded)::after background-color: rgba(255, 0, 0, 0.5)' }],
        ["a folded link's padding", '/work', 'main ul li h2 a{padding-left:1px!important}', undefined, undefined, { seen: '(folded) padding-left: 1px' }],
        ["a folded link's border", '/work', 'main ul li h2 a{border-bottom:1px solid!important}', undefined, undefined, { seen: '(folded) border-bottom-width: 1px' }],
        ["a folded link's ::after border at rest", '/work', 'main ul li h2 a::after{border-top:1px solid!important}', undefined, undefined, { seen: '(folded)::after border-top-width: 1px' }],
        // FOLD_PAINT pins a folded element's ::before and ::after to no text: a word on the title link's ::after must fail.
        ["a folded link's ::after with text at rest", '/work', 'main ul li h2 a::after{content:"x"!important}', undefined, undefined, { seen: '(folded)::after content: "x"' }],
        // The Viewer's own theme tokens ride its module (themes PR 4): one leaking into Dark must fail it.
        ["the Viewer's bands gone", `${series}/photo/${HOME_OPENING}`, '[data-surface="viewer"]{--cc-bands:none!important}', undefined, undefined],
        // The Viewer heading's folded title (#175): its own ink must fail as a fold line, the first mutant on any fold
        // that its inherited check sees. A size change needs none: the h1's box, compared at 0 px, catches it.
        ["the Viewer heading's title red", `${series}/photo/${HOME_OPENING}`, '[data-surface="viewer"] header h1 > span{color:rgb(255 0 0)!important}', undefined, undefined, { seen: '>span (folded) color: rgb(255, 0, 0)' }],
        // A changed title, in the head only (nothing in the base matches the span): left out of the walk as a fold, it
        // must still fail, by the h1's box.
        ["the Viewer heading's title changed", `${series}/photo/${HOME_OPENING}`, '', changeViewerTitle, undefined, { box: '>h1:nth-of-type(1): ' }],
    ] as const) {
        const only = rest[0] && 'within' in rest[0] ? (rest[0] as { within: string; property: string }) : null;
        const seen = rest[0] && 'seen' in rest[0] ? (rest[0] as { seen: string }).seen : null;
        const box = rest[0] && 'box' in rest[0] ? (rest[0] as { box: string }).box : null;
        test(`self-test: ${name} in the head fails the gate`, async () => {
            // Work's under its sanctioned departures, as the gate's `work` rows are, so B3's entry box (`position`)
            // can't be what fails it: what's left is the injected change. The Viewer's leaves out
            // what its gate rows do, the old spoken position and the base's Camera make row, for the same reason.
            const pair: Pair = {
                name: `self-test, ${name}`,
                url,
                headStyle,
                act,
                motion,
                ...(url === '/work' && { stateOf: 'work' }),
                ...(url === `${series}/photo/${HOME_OPENING}` && { leaveOut: VIEWER_POSITION, cameraRows: true as const }),
            };
            const viewport = VIEWPORTS.desktop;
            const [base, head] = [await styles(visitor.base, 'dark', pair, viewport, 'base'), await styles(visitor.head, 'dark', pair, viewport, 'head')];
            // Both on a stored `dark`, the gate's route of that name.
            const comparison = compare(base.walk, head.walk, {}, sanctionedFor(pair, viewport.width, base.walk, 'a stored `dark`'));
            judge(pair.name, viewport.width, comparison, [...base.timedOut, ...head.timedOut]);
            // Seen as the change itself, in a style or a token, on loads that settled; a change that moves only a box, in its
            // geometry, at that box.
            if (box) expect(comparison.geometry.filter((line) => line.includes(box)).length, `${name}: seen as the box ${box}`).toBeGreaterThan(0);
            else expect(comparison.styles.length + comparison.tokens.length, `${name}: the computed-style gate sees it`).toBeGreaterThan(0);
            if (seen) expect(comparison.styles.filter((line) => line.includes(seen)).length, `${name}: seen as ${seen}`).toBeGreaterThan(0);
            if (only) {
                // Seen where it was put, and nowhere else.
                expect(comparison.styles.filter((line) => line.includes(only.property)).length, `${name}: seen as ${only.property}`).toBeGreaterThan(0);
                expect(comparison.styles.filter((line) => !line.includes(only.within)), `${name}: seen only under ${only.within}`).toEqual([]);
            }
            expect([...base.timedOut, ...head.timedOut], `${name}: both loads settled`).toEqual([]);
        });
    }

    // Work's reveal (WORK_REVEAL) is sanctioned as exactly 160 px. A px more or less on the room's foot padding moves it
    // 161 or 159 px, and the gate, under that sanction, must fail every box, off by 1 px, and see nothing else.
    for (const [moved, padding] of [
        [161, 'calc(8rem + 1px)'],
        [159, 'calc(8rem - 1px)'],
    ] as const) {
        test(`self-test: Work's reveal at ${moved} px, not 160, in the head fails the gate`, async () => {
            const focus = VISITOR.find((candidate) => candidate.name === 'work-focus')!;
            // The work-focus pair itself, so its sanctions and its pinned ring apply; html isn't walked, so the padding
            // is seen only through the scroll it changes.
            const pair: Pair = { ...focus, headStyle: `html{scroll-padding-bottom:${padding}!important}` };
            const viewport = VIEWPORTS.desktop;
            const route = SCRIPTED_ROUTES[0];
            const [base, head] = [await styles(visitor.base, 'dark', pair, viewport, 'base'), await styles(visitor.head, '', pair, viewport, 'head')];
            expect([...base.timedOut, ...head.timedOut], 'both loads settled').toEqual([]);
            const { allowances, shifts } = geometryFor(pair, viewport.width, route, base.walk);
            expect(Object.keys(shifts).length, 'the reveal sanction applies to the page').toBeGreaterThan(0);
            const comparison = compare(base.walk, head.walk, allowances, sanctionedFor(pair, viewport.width, base.walk, route), shifts);
            judge(`self-test, Work's reveal at ${moved} px`, viewport.width, comparison);
            expect(comparison.geometry.length, `the gate sees a ${moved} px reveal`).toBeGreaterThan(0);
            expect(comparison.geometry.filter((line) => !line.includes('off by 1 px')), 'every box is off the sanctioned shift by 1 px').toEqual([]);
            expect([...comparison.structural, ...comparison.styles, ...comparison.tokens], 'and nothing else differs').toEqual([]);
        });
    }

    // Black's page must never pass as Dark (the remap's review, L1): the head on a stored `black` fails both the gate's
    // paint check and its comparison, since Black's layer computes its own styles and tokens.
    test("self-test: Black's page in the head fails the gate as Dark", async () => {
        // Under Work's sanctioned departures, so B3's entry box can't be what the comparison sees (B3's CI review, S1).
        const pair: Pair = { name: "self-test, Black's page", url: '/work', stateOf: 'work' };
        const viewport = VIEWPORTS.desktop;
        const [base, head] = [await styles(visitor.base, 'dark', pair, viewport, 'base'), await styles(visitor.head, 'black', pair, viewport, 'head')];
        expect([...base.timedOut, ...head.timedOut], 'both loads settled').toEqual([]);
        expect(paintsDark(head), 'the gate sees Black').toEqual(['painted black, not dark']);
        // The head on a stored theme with JavaScript, against the base's stored `dark`: the gate's stored route.
        const comparison = compare(base.walk, head.walk, {}, sanctionedFor(pair, viewport.width, base.walk, 'a stored `dark`'));
        expect(comparison.styles.length + comparison.tokens.length, "the comparison sees Black's styles too").toBeGreaterThan(0);
        // And a Dark head passes the same check, so the check isn't failing everything.
        expect(paintsDark(await styles(visitor.head, 'dark', pair, viewport, 'head')), 'a Dark head passes it').toEqual([]);
        // A missing theme passes only on Next's error shell: a normal page with its theme taken off fails, even
        // against a base with none either.
        const [bare, bareBase] = [await styles(visitor.head, 'dark', pair, viewport, 'head', { stripTheme: true }), await styles(visitor.base, 'dark', pair, viewport, 'base', { stripTheme: true })];
        expect([bare.theme, bare.shell, bareBase.shell], 'the stripped pages are normal pages with no theme').toEqual([null, false, false]);
        expect(paintsDark(bare, bareBase), 'a normal page with no theme fails').toEqual(['painted nothing, not dark']);
    });
});

test.describe('the curator and its 503', () => {
    const servers: Server[] = [];
    let curator = { base: '', head: '' };
    let broken = { base: '', head: '' };
    const cookies = { base: '', head: '' };

    test.beforeAll(async () => {
        inbox = await createInboxFixture();
        await openInboxItems(inbox);
        secrets = await makeCuratorSecrets();
        const [a, b, c, d] = [port(0), port(1), port(2), port(3)];
        const env = (listen: number, secretEnv: Record<string, string>) => ({
            PHOTOGRAPHY_LIBRARY_DIR: inbox!.library,
            PHOTOGRAPHY_SITE_CONFIG_DIR: siteConfig,
            PHOTOGRAPHY_DATA_DIR: inbox!.root,
            CURATION_ENABLED: 'true',
            CURATOR_TUNNEL_PORT: String(listen),
            ...secretEnv,
        });
        const signedIn = secrets.env;
        const missing = { CURATOR_PASSPHRASE_HASH_FILE: path.join(temp, 'no-such.hash'), CURATOR_SESSION_SECRET_FILE: path.join(temp, 'no-such.key') };
        const started = await Promise.all([
            serve(BASE!, a, (listen) => env(listen, signedIn), '/curation/login'),
            serve(HEAD, b, (listen) => env(listen, signedIn), '/curation/login'),
            serve(BASE!, c, (listen) => env(listen, missing), '/curation/login', 503),
            serve(HEAD, d, (listen) => env(listen, missing), '/curation/login', 503),
        ]);
        servers.push(...started);
        curator = { base: started[0].origin, head: started[1].origin };
        broken = { base: started[2].origin, head: started[3].origin };
        // One session per server, signed in through its own form, as the owner does.
        for (const which of ['base', 'head'] as const) {
            const context = await browser.newContext();
            const page = await context.newPage();
            await page.goto(`${curator[which]}/curation/login`);
            await page.waitForSelector('html[data-hydrated]');
            await page.getByLabel('Passphrase').fill(secrets.passphrase);
            await page.getByRole('button', { name: 'Sign in' }).click();
            await page.waitForURL(`${curator[which]}/curation`);
            cookies[which] = JSON.stringify((await context.cookies()).map(({ name, value }) => ({ name, value })));
            await context.close();
        }
    });

    test.afterAll(async () => {
        await Promise.all(servers.map((server) => server.stop()));
    });

    // The self-test for the Inbox's own hydration wait: it passes on the base, which has no submit gate, and fails by name
    // on the head when a form is kept waiting, or one React never claimed is there.
    test('self-test: the Inbox act fails by name when a form never hydrates, and passes on the base', async () => {
        const load = async (which: 'base' | 'head') => {
            const context = await browser.newContext({ viewport: VIEWPORTS.desktop, colorScheme: 'dark', reducedMotion: 'reduce' });
            await context.addCookies(JSON.parse(cookies[which]).map((cookie: { name: string; value: string }) => ({ ...cookie, url: curator[which] })));
            const page = await context.newPage();
            await page.goto(`${curator[which]}/curation/inbox`);
            await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
            return { context, page };
        };
        const base = await load('base');
        try {
            await inboxIn(base.page);
        } finally {
            await base.context.close();
        }
        for (const [form, reason] of [
            ['<form aria-label="Kept waiting" data-submit-gate="waiting"></form>', /^The Inbox didn't hydrate within \d+ ms: an Inbox form kept waiting: Kept waiting$/],
            ['<form aria-label="Never claimed"></form>', /^The Inbox didn't hydrate within \d+ ms: an Inbox form was never claimed by React: Never claimed$/],
        ] as const) {
            const head = await load('head');
            try {
                await inboxIn(head.page);
                // A form the server never sent and React never saw, put where the Inbox's forms are.
                await head.page.evaluate((html) => document.querySelector('main')!.insertAdjacentHTML('beforeend', html), form);
                await expect(inboxIn(head.page, { timeout: 3000 })).rejects.toThrow(reason);
            } finally {
                await head.context.close();
            }
        }
    });

    parity('curator', CURATOR, () => curator, { legacy: true, session: () => cookies });
    parity('curator', [{ name: '503', url: '/curation/login', bare: true }], () => broken, { legacy: true });
});

test.describe('the error page', () => {
    const servers: Server[] = [];
    let failing = { base: '', head: '' };

    test.beforeAll(async () => {
        // A catalog whose active pointer is damaged: the site has cut over and can't read it, so a page throws and the
        // visitor gets app/error.tsx.
        const root = path.join(temp, 'damaged');
        fs.mkdirSync(path.join(root, 'catalog', 'active'), { recursive: true });
        fs.writeFileSync(path.join(root, 'catalog', 'active', 'v1.json'), 'not a pointer');
        const env = { PHOTOGRAPHY_LIBRARY_DIR: library, PHOTOGRAPHY_SITE_CONFIG_DIR: siteConfig, PHOTOGRAPHY_DATA_DIR: root };
        const [a, b] = [port(0), port(1)];
        const started = await Promise.all([serve(BASE!, a, env, '/work', 500), serve(HEAD, b, env, '/work', 500)]);
        servers.push(...started);
        failing = { base: started[0].origin, head: started[1].origin };
    });

    test.afterAll(async () => {
        await Promise.all(servers.map((server) => server.stop()));
    });

    parity('visitor', [{ name: 'error', url: '/work', measure: ['nav [class*="monogram"]', 'nav [class*="_end"]', '[data-theme-control], nav button'] }], () => failing, { legacy: true });
});
