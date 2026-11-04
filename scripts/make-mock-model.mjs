// Builds tests/fixtures/mock-model: a model3.json bundle for the mock Core (test double).
import { writeFileSync } from 'node:fs';
import { encodePng } from '../packages/psd-importer/src/png.ts';

const dir = 'tests/fixtures/mock-model';
const sq = (cx, cy, h) => [cx - h, cy + h, cx + h, cy + h, cx + h, cy - h, cx - h, cy - h]; // units, y up
const moc = {
  version: 4,
  canvas: { CanvasWidth: 400, CanvasHeight: 400, CanvasOriginX: 200, CanvasOriginY: 200, PixelsPerUnit: 400 },
  parameters: [
    { id: 'ParamAngleX', min: -30, max: 30, default: 0 },
    { id: 'ParamEyeBallX', min: -1, max: 1, default: 0 },
  ],
  drawables: [
    // Face: left half of the texture (red), 160 px square at the centre.
    { id: 'ArtMesh_Face', texture: 0, renderOrder: 0, masks: [], vertices: sq(0, 0, 0.2), uvs: [0, 1, 0.5, 1, 0.5, 0, 0, 0], indices: [0, 1, 2, 0, 2, 3], moveX: { ParamAngleX: 0.002 } },
    // Iris: right half of the texture (blue), masked by the face, moves with ParamEyeBallX.
    { id: 'ArtMesh_Iris', texture: 0, renderOrder: 1, masks: [0], vertices: sq(0, 0, 0.06), uvs: [0.5, 1, 1, 1, 1, 0, 0.5, 0], indices: [0, 1, 2, 0, 2, 3], moveX: { ParamEyeBallX: 0.25, ParamAngleX: 0.002 } },
  ],
};
writeFileSync(`${dir}/mock.moc3`, Buffer.concat([Buffer.from('MOCK'), Buffer.from(JSON.stringify(moc))]));
const W = 64, H = 32, px = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.set(x < 32 ? [230, 60, 60, 255] : [40, 80, 230, 255], (y * W + x) * 4);
writeFileSync(`${dir}/textures/texture_00.png`, encodePng(W, H, px));
writeFileSync(`${dir}/mock.model3.json`, JSON.stringify({
  Version: 3,
  FileReferences: { Moc: 'mock.moc3', Textures: ['textures/texture_00.png'], Physics: 'mock.physics3.json', Motions: { Idle: [{ File: 'motions/look.motion3.json' }] } },
}, null, 2));
writeFileSync(`${dir}/mock.physics3.json`, JSON.stringify({
  Version: 3,
  Meta: { PhysicsSettingCount: 0, TotalInputCount: 0, TotalOutputCount: 0, VertexCount: 0, EffectiveForces: { Gravity: { X: 0, Y: -1 }, Wind: { X: 0, Y: 0 } }, PhysicsDictionary: [] },
  PhysicsSettings: [],
}));
writeFileSync(`${dir}/motions/look.motion3.json`, JSON.stringify({
  Version: 3, Meta: { Duration: 2, Fps: 30, Loop: true, AreBeziersRestricted: true, CurveCount: 1, TotalSegmentCount: 2, TotalPointCount: 3 },
  Curves: [{ Target: 'Parameter', Id: 'ParamEyeBallX', Segments: [0, -1, 0, 1, 1, 0, 2, -1] }],
}));
console.log('wrote', dir);
