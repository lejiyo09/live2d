/*
 * TEST DOUBLE — NOT Live2D code. A tiny stand-in for the Cubism Core global
 * (`Live2DCubismCore`) implementing the subset of the interface used by
 * packages/cubism-adapter, over a fake "MOCK" + JSON moc format. Used only to
 * test the preview pipeline; real .moc3 files need the official Core.
 */
(function () {
  const dec = new TextDecoder();
  function parse(buf) {
    const u = new Uint8Array(buf);
    if (u.length < 4 || String.fromCharCode(u[0], u[1], u[2], u[3]) !== 'MOCK') return null;
    try { return JSON.parse(dec.decode(u.slice(4))); } catch { return null; }
  }
  class Moc {
    constructor(d) { this.d = d; }
    _release() {}
    hasMocConsistency(buf) { return parse(buf) ? 1 : 0; }
    static fromArrayBuffer(buf) { const d = parse(buf); return d ? new Moc(d) : null; }
  }
  class Model {
    static fromMoc(moc) { return new Model(moc.d); }
    constructor(d) {
      this.d = d;
      const P = d.parameters;
      this.parameters = {
        count: P.length, ids: P.map((p) => p.id),
        minimumValues: Float32Array.from(P.map((p) => p.min)), maximumValues: Float32Array.from(P.map((p) => p.max)),
        defaultValues: Float32Array.from(P.map((p) => p.default)), values: Float32Array.from(P.map((p) => p.default)),
        repeats: Int32Array.from(P.map(() => 0)),
      };
      this.parts = { count: 1, ids: ['PartAll'], opacities: Float32Array.of(1), parentIndices: Int32Array.of(-1) };
      const D = d.drawables;
      this.drawables = {
        count: D.length, ids: D.map((x) => x.id),
        constantFlags: Uint8Array.from(D.map((x) => (x.blend === 'add' ? 1 : x.blend === 'multiply' ? 2 : 0) | (x.inverted ? 8 : 0))),
        dynamicFlags: Uint8Array.from(D.map(() => 1)),
        textureIndices: Int32Array.from(D.map((x) => x.texture)),
        opacities: Float32Array.from(D.map(() => 1)),
        maskCounts: Int32Array.from(D.map((x) => x.masks.length)),
        masks: D.map((x) => Int32Array.from(x.masks)),
        vertexCounts: Int32Array.from(D.map((x) => x.vertices.length / 2)),
        vertexPositions: D.map((x) => Float32Array.from(x.vertices)),
        vertexUvs: D.map((x) => Float32Array.from(x.uvs)),
        indexCounts: Int32Array.from(D.map((x) => x.indices.length)),
        indices: D.map((x) => Uint16Array.from(x.indices)),
        resetDynamicFlags() {},
      };
      this.canvasinfo = d.canvas;
      this._ro = Int32Array.from(D.map((x) => x.renderOrder));
    }
    getRenderOrders() { return this._ro; }
    update() {
      const ids = this.parameters.ids, vals = this.parameters.values;
      this.d.drawables.forEach((x, i) => {
        const pos = this.drawables.vertexPositions[i];
        let dx = 0;
        for (const [pid, k] of Object.entries(x.moveX ?? {})) dx += (vals[ids.indexOf(pid)] ?? 0) * k;
        for (let v = 0; v < pos.length; v += 2) { pos[v] = x.vertices[v] + dx; pos[v + 1] = x.vertices[v + 1]; }
      });
    }
    release() {}
  }
  globalThis.Live2DCubismCore = {
    Version: { csmGetVersion: () => 0x05000000, csmGetLatestMocVersion: () => 5, csmGetMocVersion: (buf) => (parse(buf) ? parse(buf).version : 0) },
    Moc, Model,
    Utils: {
      hasIsVisibleBit: (f) => (f & 1) === 1,
      hasBlendAdditiveBit: (f) => (f & 1) === 1,
      hasBlendMultiplicativeBit: (f) => (f & 2) === 2,
      hasIsDoubleSidedBit: (f) => (f & 4) === 4,
      hasIsInvertedMaskBit: (f) => (f & 8) === 8,
    },
  };
})();
