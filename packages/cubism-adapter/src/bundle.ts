import { strToU8, zip } from 'fflate';
import type { Project } from '@l2s/editor-core';
import { clipToMotion3 } from './motion3.ts';
import { rigToPhysics3 } from './physics3.ts';
import { projectToCdi3 } from './cdi3.ts';
import { expressionToExp3 } from './exp3.ts';

export interface InteropReport {
  files: string[];
  warnings: string[];
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_\-]+/g, '_').replace(/^_+|_+$/g, '') || 'motion';

/**
 * JSON-only interop bundle (spec §11.5 subset). No .moc3 / model3.json is
 * produced: MOC3 generation requires an authorized export path (§11.4), so
 * these files are meant to drive an *existing* official model whose
 * parameter IDs match.
 */
export async function buildInteropBundle(p: Project): Promise<{ zip: Uint8Array; report: InteropReport }> {
  const base = safe(p.name) || 'Character';
  const files: Record<string, Uint8Array> = {};
  const warnings: string[] = [];
  const json = (o: unknown) => strToU8(JSON.stringify(o, null, '\t'));
  if (p.physics.settings.length) files[`${base}.physics3.json`] = json(rigToPhysics3(p.physics));
  files[`${base}.cdi3.json`] = json(projectToCdi3(p));
  const used = new Set<string>();
  for (const c of p.animations) {
    let n = safe(c.name);
    while (used.has(n)) n += '_';
    used.add(n);
    files[`motions/${n}.motion3.json`] = json(clipToMotion3(c));
  }
  const usedEx = new Set<string>();
  for (const e of p.expressions ?? []) {
    let n = safe(e.name);
    while (usedEx.has(n)) n += '_';
    usedEx.add(n);
    files[`expressions/${n}.exp3.json`] = json(expressionToExp3(e));
  }
  const nonStd = p.parameters.filter((x) => !/^Param[A-Z]/.test(x.id)).map((x) => x.id);
  if (nonStd.length) warnings.push(`Parameter IDs not following the Cubism "Param…" convention: ${nonStd.join(', ')}`);
  files['README.txt'] = strToU8([
    `Live2D Studio interop export — ${p.name}`,
    '',
    'Contains Cubism JSON files (Version 3): physics3, cdi3, motion3 and exp3.',
    'There is NO .moc3 and NO model3.json: a MOC3 can only be produced through an authorized',
    'export path (e.g. Live2D Cubism Editor). Use these files with an existing official model',
    'whose parameter IDs match. Compatibility is not certified until validated with the official',
    'Cubism Core / SDK (spec §11.6).',
    '',
    `Parameters: ${p.parameters.map((x) => x.id).join(', ')}`,
  ].join('\n'));
  const data = await new Promise<Uint8Array>((res, rej) => zip(files, { level: 6 }, (e, d) => (e ? rej(e) : res(d))));
  return { zip: data, report: { files: Object.keys(files), warnings } };
}
