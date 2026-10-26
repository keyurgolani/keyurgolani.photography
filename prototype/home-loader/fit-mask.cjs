// Lines each recording up on the mask itself. In every frame of the reveal it
// measures the hole's radius on the center row (the background photo is blue,
// the grain overlay near black), turns it into the mask's progress, inverts
// framer's easeInOut (cubic-bezier(0.42, 0, 0.58, 1)) over the 1.2 s reveal,
// and takes the median start time. Then it renames the frames and shifts the
// timeline so R is that start.
//   node fit-mask.cjs <recording dir>...
const fs = require('fs'); const path = require('path'); const sharp = require('sharp');
const bez = (a, b, t) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
function easeInOutInverse(y) {
  // y(x) of cubic-bezier(0.42, 0, 0.58, 1): solve for x by bisection on the curve's t.
  let lo = 0, hi = 1;
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; (bez(0, 1, m) < y ? (lo = m) : (hi = m)); }
  return bez(0.42, 0.58, (lo + hi) / 2);
}
(async () => {
  for (const dir of process.argv.slice(2)) {
    const file = path.join(dir, 'timeline.json');
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    const [vw, vh] = t.viewport;
    const r0 = vw >= 768 ? 160 : 128, rMax = Math.ceil(Math.hypot(vw, vh));
    const starts = [];
    for (const f of t.frames.filter((f) => f.rel > 0 && f.rel < 1100)) {
      const { data, info } = await sharp(path.join(dir, 'frames', f.name)).raw().toBuffer({ resolveWithObject: true });
      const s = info.width / vw, ch = info.channels;
      // Along the longer axis, from the frame's edge inward: the first blue pixel marks the hole's edge.
      const vertical = vh > vw;
      const half = vertical ? info.height / 2 : info.width / 2;
      const px = (k) => { const x = vertical ? Math.round(info.width / 2) : k, y = vertical ? k : Math.round(info.height / 2); return (y * info.width + x) * ch; };
      // Horizontal: from the right edge inward. Vertical: from the top edge down (the photo's bottom is dark mountains).
      let r = null;
      if (vertical) {
        for (let k = 0; k < half - 175 * s; k++) {
          const i = px(k);
          if (data[i + 2] > 45 && data[i + 2] > data[i] + 15) { r = (half - k) / s; break; }
        }
      } else {
        for (let k = info.width - 1; k > half + 175 * s; k--) {
          const i = px(k);
          if (data[i + 2] > 45 && data[i + 2] > data[i] + 15) { r = (k - half) / s; break; }
        }
      }
      if (r === null) continue;
      if (r < 200 || r > Math.min((vertical ? vh : vw) / 2, rMax) - 20) continue; // past the portrait, inside the frame
      const p = (r - r0) / (rMax - r0);
      starts.push(f.rel - easeInOutInverse(p) * 1200);
    }
    if (starts.length < 3 || t.maskFit) { console.log(path.basename(dir), 'too few mask frames', starts.length); continue; }
    starts.sort((a, b) => a - b);
    const shift = Math.round(starts[Math.floor(starts.length / 2)]);
    const spread = Math.round(starts[Math.floor(starts.length * 0.9)] - starts[Math.floor(starts.length * 0.1)]);
    for (const f of t.frames) {
      const rel = f.rel - shift;
      const name = `${f.name.slice(0, 4)}_${rel >= 0 ? '+' : '-'}${String(Math.abs(rel)).padStart(5, '0')}ms.jpg`;
      if (name !== f.name) fs.renameSync(path.join(dir, 'frames', f.name), path.join(dir, 'frames', name));
      Object.assign(f, { name, rel });
    }
    for (const x of t.samples) x.rel -= shift;
    for (const m of Object.values(t.marks)) m.sinceReveal -= shift;
    t.marks.revealStart.sinceNav += shift;
    t.marks.revealStart.derived = `fitted to the mask radius in ${starts.length} frames (10-90% spread ${spread} ms)`;
    t.maskFit = { shiftMs: shift, frames: starts.length, spreadMs: spread };
    const drop = t.samples.find((s) => s.opacity !== undefined && s.opacity < 0.999);
    t.check = { ...t.check, firstOpacityBelow1AfterFit: drop?.rel ?? null };
    fs.writeFileSync(file, JSON.stringify(t, null, 1));
    console.log(path.basename(dir).padEnd(32), 'shift', shift, 'frames', starts.length, 'spread', spread, 'fade first <1 at R+' + (drop?.rel ?? '-'));
  }
})();
