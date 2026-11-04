// Minimal typings: the package publishes raw .ts sources as "types", which do not
// compile under this repo's strict settings (noUncheckedIndexedAccess).
export interface DelaunatorLike {
  coords: { readonly length: number; readonly [n: number]: number };
  triangles: { length: number; [n: number]: number };
  halfedges: { length: number; [n: number]: number };
  hull: { length: number; [n: number]: number };
}
export default class Constrainautor {
  del: DelaunatorLike;
  constructor(del: DelaunatorLike, edges?: readonly [number, number][]);
  constrainOne(segP1: number, segP2: number): number;
  delaunify(deep?: boolean): this;
  constrainAll(edges: readonly [number, number][]): this;
  isConstrained(edg: number): boolean;
  findEdge(p1: number, p2: number): number;
}
