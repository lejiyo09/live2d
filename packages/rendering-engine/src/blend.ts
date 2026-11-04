import type { BLEND_MODES } from 'pixi.js';
import type { BlendMode } from '@l2s/editor-core';

/**
 * PSD → PixiJS blend mode mapping. Modes without a GPU equivalent fall back to
 * the closest one and are reported via `isApproximated`.
 */
const MAP: Record<BlendMode, BLEND_MODES> = {
  'pass-through': 'normal',
  normal: 'normal',
  dissolve: 'normal',
  darken: 'darken',
  multiply: 'multiply',
  'color-burn': 'color-burn',
  'linear-burn': 'linear-burn',
  'darker-color': 'darken',
  lighten: 'lighten',
  screen: 'screen',
  'color-dodge': 'color-dodge',
  'linear-dodge': 'add',
  'lighter-color': 'lighten',
  overlay: 'overlay',
  'soft-light': 'soft-light',
  'hard-light': 'hard-light',
  'vivid-light': 'vivid-light',
  'linear-light': 'linear-light',
  'pin-light': 'pin-light',
  'hard-mix': 'hard-mix',
  difference: 'difference',
  exclusion: 'exclusion',
  subtract: 'subtract',
  divide: 'divide',
  hue: 'color', // PixiJS has no hue mode
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
};

const APPROX = new Set<BlendMode>(['dissolve', 'darker-color', 'lighter-color', 'hue']);

export function toPixiBlend(mode: BlendMode): BLEND_MODES {
  return MAP[mode];
}

export function isApproximated(mode: BlendMode): boolean {
  return APPROX.has(mode);
}

/** Blend modes that need `pixi.js/advanced-blend-modes` (back-buffer based). */
export function isAdvanced(mode: BLEND_MODES): boolean {
  return !['normal', 'add', 'multiply', 'screen', 'erase', 'none', 'inherit'].includes(mode);
}
