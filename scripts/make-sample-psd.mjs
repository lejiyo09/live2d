// Generates samples/sample-character.psd: a simple, original test character with
// nested groups, clipping masks, a layer mask, blend modes, opacity and hidden layers.
import { writeFileSync, mkdirSync } from 'node:fs';
import { writePsd } from 'ag-psd';

const W = 800, H = 1000;

function img(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = fn(x, y);
    if (c) data.set(c, (y * w + x) * 4);
  }
  return { width: w, height: h, data };
}
const ellipse = (cx, cy, rx, ry, color, soft = 1.5) => (x, y) => {
  const d = Math.sqrt(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2);
  const edge = (1 - d) * Math.min(rx, ry) / soft;
  if (edge <= 0) return null;
  return [color[0], color[1], color[2], Math.round(Math.min(1, edge) * (color[3] ?? 255))];
};
function layer(name, x, y, w, h, fn, extra = {}) {
  return { name, left: x, top: y, right: x + w, bottom: y + h, imageData: img(w, h, fn), ...extra };
}
const ell = (name, cx, cy, rx, ry, color, extra) =>
  layer(name, cx - rx - 2, cy - ry - 2, rx * 2 + 4, ry * 2 + 4, ellipse(rx + 2, ry + 2, rx, ry, color), extra);

const eye = (side, cx) => ({
  name: `눈_${side}`, opened: true, children: [
    ell(`흰자_${side}`, cx, 420, 46, 30, [250, 250, 252]),
    ell(`홍채_${side}`, cx, 422, 24, 26, [70, 120, 200], { clipping: true }),
    ell(`하이라이트_${side}`, cx - 8, 410, 7, 7, [255, 255, 255], { clipping: true, blendMode: 'screen' }),
    layer(`속눈썹_${side}`, cx - 52, 386, 104, 16, (x, y) => (y < 10 + Math.abs(x - 52) / 12 ? [40, 30, 40, 255] : null)),
  ],
});

// A hair layer with a soft gradient layer mask fading toward the tips.
const backHair = ell('뒷머리', 400, 520, 250, 330, [90, 60, 70]);
backHair.mask = {
  left: 150, top: 190, right: 650, bottom: 850, defaultColor: 0,
  imageData: img(500, 660, (x, y) => { const v = Math.round(255 * Math.min(1, (660 - y) / 200)); return [v, v, v, 255]; }),
};

const psd = {
  width: W, height: H,
  children: [
    { name: '뒷머리 그룹', opened: true, children: [backHair] },
    { name: '몸', opened: false, children: [
      layer('목', 360, 600, 80, 120, () => [245, 214, 196, 255]),
      ell('옷', 400, 860, 220, 170, [60, 70, 110]),
      ell('리본', 400, 720, 50, 26, [210, 60, 80], { blendMode: 'normal' }),
    ] },
    { name: '얼굴', opened: true, children: [
      ell('얼굴', 400, 420, 190, 220, [250, 222, 205]),
      ell('볼_좌', 300, 500, 40, 22, [255, 120, 130, 140], { blendMode: 'multiply', opacity: 0.6 }),
      ell('볼_우', 500, 500, 40, 22, [255, 120, 130, 140], { blendMode: 'multiply', opacity: 0.6 }),
      eye('좌', 320), eye('우', 480),
      ell('눈썹_좌', 320, 360, 42, 8, [70, 50, 55]),
      ell('눈썹_우', 480, 360, 42, 8, [70, 50, 55]),
      ell('입_열림', 400, 550, 30, 18, [160, 50, 60], { hidden: true }),
      ell('입_닫힘', 400, 548, 26, 5, [150, 60, 70]),
    ] },
    { name: '앞머리', opened: true, children: [
      ell('앞머리_좌', 320, 250, 130, 120, [100, 70, 80]),
      ell('앞머리_우', 480, 250, 130, 120, [100, 70, 80]),
      ell('앞머리 그림자', 400, 300, 170, 50, [40, 20, 40, 120], { blendMode: 'multiply', clipping: false, opacity: 0.5 }),
    ] },
  ],
};

mkdirSync('samples', { recursive: true });
const composite = img(W, H, () => [0, 0, 0, 0]);
writeFileSync('samples/sample-character.psd', Buffer.from(writePsd({ ...psd, imageData: composite }, { noBackground: true })));
console.log('wrote samples/sample-character.psd');
