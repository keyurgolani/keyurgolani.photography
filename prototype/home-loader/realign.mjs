// Re-zeroes recordings made before record.mjs could read Chrome's mask
// serialization (it drops `circle` and `at 50% 50%`), so revealStart was never
// marked and frames were named from the settle. The reveal start is derived
// from the settle, which the code fixes exactly: on `next` and the prototype
// the intro unmounts when the 1.2 s mask completes (R + 1200); on v1.1.0 it
// settles 50 ms after the 0.8 s landing that starts at R + 300 (R + 1150).
// Cross-checked in each recording: the portrait's opacity first reads below 1
// one sample after R (next, prototype), and v1.1.0's box first moves at R + 300.
//   node realign.mjs <recording dir>...
import fs from 'node:fs';
import path from 'node:path';

for (const dir of process.argv.slice(2).filter((a) => !a.startsWith("--"))) {
    const file = path.join(dir, 'timeline.json');
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (t.marks.revealStart) continue; // marked at recording, or already realigned
    const settleAfterR = path.basename(dir).startsWith('v110') ? 1150 : 1200;
    const gone = t.marks.maskGone.sinceNav;
    const rSinceNav = gone - settleAfterR;
    const shift = t.marks.maskGone.sinceReveal - settleAfterR; // old zero minus new zero, in ms
    for (const f of t.frames) {
        const rel = f.sinceNav - rSinceNav;
        const name = `${f.name.slice(0, 4)}_${rel >= 0 ? '+' : '-'}${String(Math.abs(rel)).padStart(5, '0')}ms.jpg`;
        fs.renameSync(path.join(dir, 'frames', f.name), path.join(dir, 'frames', name));
        Object.assign(f, { name, rel });
    }
    for (const s of t.samples) s.rel -= shift;
    for (const m of Object.values(t.marks)) m.sinceReveal = m.sinceNav - rSinceNav;
    t.marks.revealStart = { sinceNav: rSinceNav, sinceReveal: 0, derived: `maskGone - ${settleAfterR}` };
    const drop = t.samples.find((s) => s.opacity !== undefined && s.opacity < 0.999);
    const first = t.samples.find((s) => s.box);
    const moved = t.samples.find((s) => s.box && first && Math.abs(s.box[1] - first.box[1]) > 0.5);
    t.check = { firstOpacityBelow1: drop?.rel ?? null, firstBoxMove: moved?.rel ?? null };
    t.zero = 'revealStart(derived)';
    fs.writeFileSync(file, JSON.stringify(t, null, 1));
    console.log(path.basename(dir), t.check);
}

// Second pass (--refine): the settle can land a frame or two late, so line the
// recordings up on the portrait's own fade instead, which starts at R: the
// 300 ms CSS ease-out (cubic-bezier(0, 0, 0.58, 1)) passes opacity 0.5 at a
// fixed time after its start. v1.1.0 doesn't fade there, so it lines up on
// its landing instead, which starts at R + 300: its box's first 1 px of travel.
if (process.argv.includes('--refine')) {
    const bez = (p1, p2, t) => 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3;
    let lo = 0, hi = 1;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; (bez(0, 1, m) < 0.5 ? (lo = m) : (hi = m)); }
    const halfAt = 300 * bez(0, 0.58, (lo + hi) / 2); // ms after the fade starts
    for (const dir of process.argv.slice(2).filter((a) => !a.startsWith('--'))) {
        const file = path.join(dir, 'timeline.json');
        const t = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (t.refined) continue;
        let cross = null;
        const s = t.samples.filter((x) => x.opacity !== undefined && x.rel > -200 && x.rel < 600);
        if (path.basename(dir).startsWith('v110')) {
            const first = t.samples.find((x) => x.box);
            const i = t.samples.findIndex((x) => x.box && Math.abs(x.box[1] - first.box[1]) > 0.5);
            if (i > 0) cross = t.samples[i].rel - 300 + halfAt; // treated like a fade crossing below
        } else {
            for (let i = 1; i < s.length; i++) {
                if (s[i - 1].opacity >= 0.5 && s[i].opacity < 0.5) {
                    const f = (s[i - 1].opacity - 0.5) / (s[i - 1].opacity - s[i].opacity);
                    cross = s[i - 1].rel + f * (s[i].rel - s[i - 1].rel);
                    break;
                }
            }
        }
        if (cross === null) { console.log(path.basename(dir), 'no fade or landing, kept'); continue; }
        const shift = Math.round(cross - halfAt);
        for (const f of t.frames) {
            const rel = f.rel - shift;
            const name = `${f.name.slice(0, 4)}_${rel >= 0 ? '+' : '-'}${String(Math.abs(rel)).padStart(5, '0')}ms.jpg`;
            fs.renameSync(path.join(dir, 'frames', f.name), path.join(dir, 'frames', name));
            Object.assign(f, { name, rel });
        }
        for (const x of t.samples) x.rel -= shift;
        for (const m of Object.values(t.marks)) m.sinceReveal -= shift;
        t.marks.revealStart.sinceNav += shift;
        t.marks.revealStart.derived = path.basename(dir).startsWith('v110') ? 'landing start - 300' : `portrait fade passes 0.5 at R + ${halfAt.toFixed(1)} ms`;
        t.refined = { shiftMs: shift };
        fs.writeFileSync(file, JSON.stringify(t, null, 1));
        console.log(path.basename(dir), 'shifted', shift, 'ms');
    }
}
