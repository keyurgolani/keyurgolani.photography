// The brightest ripple ring around the center, per frame time: radius and mean grey.
const fs = require('fs'); const path = require('path'); const sharp = require('sharp');
(async () => {
  for (const d of process.argv.slice(2)) {
    const t = JSON.parse(fs.readFileSync(path.join(d, 'timeline.json'))); const out = [];
    for (const T of [-1500, -900, -600, -450, -301]) {
      const f = t.frames.filter((f) => f.rel <= T).at(-1);
      const { data, info } = await sharp(path.join(d, 'frames', f.name)).greyscale().raw().toBuffer({ resolveWithObject: true });
      const s2 = info.width / t.viewport[0]; const cx = info.width / 2, cy = info.height / 2; let best = [0, 0];
      for (let r = 180; r < 420; r += 10) { let s = 0, n = 0; for (let a = 0; a < 360; a += 3) { const x = Math.round(cx + r * s2 * Math.cos(a * Math.PI / 180)), y = Math.round(cy + r * s2 * Math.sin(a * Math.PI / 180)); if (y < 0 || y >= info.height) continue; s += data[y * info.width + x]; n++; } const m = s / n; if (m > best[1]) best = [r, m]; }
      out.push(`${T}:r${best[0]}/${best[1].toFixed(1)}`);
    }
    console.log(path.basename(d).padEnd(32), out.join('  '));
  }
})();
