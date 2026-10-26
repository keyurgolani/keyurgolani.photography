// Side-by-side contact sheet from record.mjs recordings (prototype only).
//
//   node contact-sheet.mjs --out sheet.jpg --times -2600,-1000,0,300 --cell 480 [--crop 480] \
//     --title "..." <label>=<recording dir> ...
//
// Rows are times relative to each recording's reveal start; columns are the
// recordings. Each cell is the frame that was on screen at that time: the last
// frame at or before it (a screencast sends a frame only when the screen changes).
// --crop N takes an N x N CSS-pixel square around the viewport center at 1:1
// before scaling to --cell, for the portrait's detail.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const argv = process.argv.slice(2);
const opts = {};
const cols = [];
for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) opts[argv[i].slice(2)] = argv[++i];
    else { const [label, dir] = argv[i].split('='); cols.push({ label, dir }); }
}
const times = opts.times.split(',').map(Number);
const cell = Number(opts.cell ?? 480);
const crop = opts.crop ? Number(opts.crop) : null;
const LABEL_H = 34, ROW_LABEL_W = 110, HEAD_H = 56;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

for (const c of cols) {
    c.tl = JSON.parse(fs.readFileSync(path.join(c.dir, 'timeline.json'), 'utf8'));
    // --align <mark> lines the columns up on another mark (portraitFirst, say) instead of the reveal start.
    const shift = opts.align ? c.tl.marks[opts.align].sinceReveal : 0;
    c.frames = c.tl.frames.map((f) => ({ ...f, rel: f.rel - shift })).sort((a, b) => a.rel - b.rel);
}
const first = await sharp(path.join(cols[0].dir, 'frames', cols[0].frames[0].name)).metadata();
const scaleOf = (c) => first.width / c.tl.viewport[0]; // frame px per CSS px
const cellH = crop ? cell : Math.round((cell * first.height) / first.width);

const W = ROW_LABEL_W + cols.length * cell;
const H = HEAD_H + times.length * (cellH + LABEL_H);
const layers = [];
const svgText = (w, h, text, { size = 15, weight = 400, fill = '#e8e8e8', bg = '#16161a', anchor = 'start', x = 8 } = {}) =>
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${bg}"/><text x="${anchor === 'middle' ? w / 2 : x}" y="${h / 2 + size / 3}" font-family="Helvetica, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(text)}</text></svg>`);

layers.push({ input: svgText(W, HEAD_H, opts.title ?? '', { size: 18, weight: 700 }), left: 0, top: 0 });
for (const [ci, c] of cols.entries()) {
    layers.push({ input: svgText(cell, HEAD_H, c.label, { size: 14, weight: 700, anchor: 'middle', bg: '#202028' }), left: ROW_LABEL_W + ci * cell, top: 0 });
}
for (const [ri, t] of times.entries()) {
    const top = HEAD_H + ri * (cellH + LABEL_H);
    layers.push({ input: svgText(ROW_LABEL_W, cellH + LABEL_H, `${opts.align ? 'P' : 'R'}${t >= 0 ? '+' : ''}${t} ms`, { size: 16, weight: 700 }), left: 0, top });
    for (const [ci, c] of cols.entries()) {
        const at = c.frames.filter((f) => f.rel <= t).at(-1);
        const left = ROW_LABEL_W + ci * cell;
        let caption = 'no frame yet';
        if (at) {
            let img = sharp(path.join(c.dir, 'frames', at.name));
            if (crop) {
                const s = scaleOf(c);
                const meta = await img.metadata();
                const side = Math.round(crop * s);
                img = sharp(await img.extract({ left: Math.round((meta.width - side) / 2), top: Math.round((meta.height - side) / 2), width: side, height: side }).toBuffer());
            }
            layers.push({ input: await img.resize(cell, cellH, { fit: 'contain', background: '#000' }).toBuffer(), left, top });
            caption = `frame at ${opts.align ? 'P' : 'R'}${at.rel >= 0 ? '+' : ''}${at.rel} ms`;
        }
        layers.push({ input: svgText(cell, LABEL_H, caption, { size: 13, fill: '#a9a9b3' }), left, top: top + cellH });
    }
}
await sharp({ create: { width: W, height: H, channels: 3, background: '#0d0d10' } }).composite(layers).jpeg({ quality: 86 }).toFile(opts.out);
console.log(`${opts.out}: ${cols.length} columns x ${times.length} rows, ${W}x${H}`);
