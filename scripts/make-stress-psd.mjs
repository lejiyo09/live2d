// Stress-test PSD: 4096×4096, 240 layers in 24 folders, sizes 80–1100 px (soft ellipses).
import { writeFileSync, mkdirSync } from 'node:fs';
import { writePsd } from 'ag-psd';

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const W = 4096, H = 4096;
function ellipseLayer(name, size) {
  const w = Math.round(size * (0.6 + rnd() * 0.8)), h = Math.round(size * (0.6 + rnd() * 0.8));
  const x = Math.round(rnd() * (W - w)), y = Math.round(rnd() * (H - h));
  const data = new Uint8ClampedArray(w * h * 4);
  const c = [Math.round(rnd() * 255), Math.round(rnd() * 255), Math.round(rnd() * 255)];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const d = Math.hypot((i - w / 2) / (w / 2), (j - h / 2) / (h / 2));
    if (d < 1) data.set([c[0], c[1], c[2], Math.round(Math.min(1, (1 - d) * 8) * 255)], (j * w + i) * 4);
  }
  return { name, left: x, top: y, right: x + w, bottom: y + h, imageData: { width: w, height: h, data } };
}
const groups = [];
for (let g = 0; g < 24; g++) {
  const children = [];
  for (let l = 0; l < 10; l++) children.push(ellipseLayer(`part_${g}_${l}`, 80 + Math.floor(rnd() ** 2 * 1020)));
  groups.push({ name: `group_${g}`, opened: g % 3 === 0, children });
}
mkdirSync('samples', { recursive: true });
const buf = writePsd({ width: W, height: H, children: groups, imageData: { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) } }, { noBackground: true });
writeFileSync('samples/stress.psd', Buffer.from(buf));
console.log('wrote samples/stress.psd', (buf.byteLength / 1048576).toFixed(1), 'MB');
