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

for (const dir of process.argv.slice(2)) {
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
