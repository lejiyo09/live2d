import { writePsd, type Layer, type Psd } from 'ag-psd';

export function solid(width: number, height: number, rgba: [number, number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width, height, data };
}

export function layer(name: string, x: number, y: number, w: number, h: number, rgba: [number, number, number, number], extra: Partial<Layer> = {}): Layer {
  return { name, left: x, top: y, right: x + w, bottom: y + h, imageData: solid(w, h, rgba), ...extra };
}

export function buildPsd(psd: Psd): Uint8Array {
  const buf = writePsd({ ...psd, imageData: psd.imageData ?? solid(psd.width, psd.height, [0, 0, 0, 0]) }, { noBackground: true });
  return new Uint8Array(buf);
}
