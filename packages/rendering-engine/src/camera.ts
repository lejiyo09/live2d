/** 2D view transform: screen = world * zoom + offset. */
export interface CameraState {
  zoom: number;
  x: number;
  y: number;
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;

export function clampZoom(z: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** Zoom keeping the world point under (sx, sy) fixed on screen. */
export function zoomAt(cam: CameraState, sx: number, sy: number, factor: number): CameraState {
  const zoom = clampZoom(cam.zoom * factor);
  const k = zoom / cam.zoom;
  return { zoom, x: sx - (sx - cam.x) * k, y: sy - (sy - cam.y) * k };
}

export function fit(viewW: number, viewH: number, contentW: number, contentH: number, padding = 32): CameraState {
  const zoom = clampZoom(Math.min((viewW - padding * 2) / contentW, (viewH - padding * 2) / contentH));
  return { zoom, x: (viewW - contentW * zoom) / 2, y: (viewH - contentH * zoom) / 2 };
}

export function screenToWorld(cam: CameraState, sx: number, sy: number) {
  return { x: (sx - cam.x) / cam.zoom, y: (sy - cam.y) / cam.zoom };
}
