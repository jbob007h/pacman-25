// Procedural maze generation.
//
// Every maze shares a fixed frame so neighbors line up in the 5x5 world:
//   - top/bottom doors at DOOR_COLS, left/right doors on SIDE_DOOR_ROW
//   - a side tunnel on TUNNEL_ROW that warps to the other side of the SAME maze
//   - a ghost house in the center with a corridor ring around it
// The left half is generated on a coarse lattice and mirrored. We start with every
// lattice edge open and randomly remove edges while keeping every junction at
// degree >= 2 (no dead ends) and the graph connected, then validate the result.
//
// To limit places you can get trapped, the maze is treated as 2 rows x 3 columns of
// sectors, and every pair of neighboring sectors must stay joined by at least
// SECTOR_PASSAGES corridors (see sectorsOk).

import { MW, MH, DOOR_COLS, SIDE_DOOR_ROW, TUNNEL_ROW } from './config';
import { Rng } from './rng';

export const T_WALL = 0;
export const T_OPEN = 1;
export const T_GATE = 2;
export const T_HOUSE = 3;
export const T_TUNNEL = 4;

export const P_NONE = 0;
export const P_DOT = 1;
export const P_POWER = 2;

export interface MazeLayout {
  tiles: Uint8Array; // MW*MH tile codes
  pellets: Uint8Array; // initial pellet layout
  dotCount: number;
  dotTiles: number[]; // indices of regular-pellet tiles (raider/airdrop spawn spots)
  powerTiles: number[];
  seed: number;
}

const ROWS = [1, 4, 7, 10, 13, 16, 20];
const COLS = [1, 5, 9, 12, 15, 18];
const HOUSE = { top: 8, bottom: 12, left: 16, right: MW - 1 - 16 };
const RING = { top: 7, bottom: 13, left: 15, right: MW - 1 - 15 };

interface Edge {
  a: string;
  b: string | null; // null = edge to the mirrored node (crosses the center)
  fixed: boolean;
  on: boolean;
}

const key = (r: number, c: number) => `${r},${c}`;

/** Minimum corridors between each pair of neighboring sectors (2 rows x 3 columns). */
export const SECTOR_PASSAGES = 1;

/**
 * Longest allowed escape loop, in tiles: for every corridor, the corridor plus the
 * shortest other way between its two ends. If a ghost shows up at one end, this is how
 * far you'd have to run to get around it. Doors count as escape hatches.
 */
export const MAX_ESCAPE_LOOP = 30;

// Lattice edges that cross a sector boundary. Columns split at x~13 and x~27 (the right
// boundary mirrors the left one), rows at y~11. The middle column's top/bottom halves are
// always joined by the fixed corridor ring around the ghost house (on both sides).
const CROSS_LEFT_MIDDLE_TOP = [1, 4, 7, 10].map((r) => `${key(r, 12)}>${key(r, 15)}`);
const CROSS_LEFT_MIDDLE_BOTTOM = [13, 16, 20].map((r) => `${key(r, 12)}>${key(r, 15)}`);
const CROSS_LEFT_TOP_BOTTOM = [1, 5, 9, 12].map((c) => `${key(10, c)}>${key(13, c)}`);

/**
 * Builds a checker for the escape-loop limit over the full (mirrored) maze. The graph is
 * built once per attempt; the checker reads each lattice edge's current `on` flag.
 * Returns true if every corridor's escape loop is at most maxLoop tiles.
 */
function makeLoopChecker(edges: Edge[]): (maxLoop: number) => boolean {
  const parse = (k: string) => k.split(',').map(Number) as [number, number];
  const id = new Map<string, number>();
  const nodeId = (r: number, c: number) => {
    const k = key(r, c);
    let v = id.get(k);
    if (v === undefined) { v = id.size; id.set(k, v); }
    return v;
  };
  const OUT = nodeId(-1, -1);
  // Graph edges: [a, b, length, owning lattice edge index or -1 if always present]
  const list: [number, number, number, number][] = [];
  const checkList: number[] = []; // graph edges whose loops we test (one copy of each mirrored pair)
  edges.forEach((e, ei) => {
    const [r1, c1] = parse(e.a);
    if (e.b === null) {
      checkList.push(list.length);
      list.push([nodeId(r1, c1), nodeId(r1, MW - 1 - c1), MW - 1 - 2 * c1, ei]);
      return;
    }
    const [r2, c2] = parse(e.b);
    const len = Math.abs(r2 - r1) + Math.abs(c2 - c1);
    checkList.push(list.length); // the mirror copy has the same loop by symmetry
    list.push([nodeId(r1, c1), nodeId(r2, c2), len, ei]);
    list.push([nodeId(r1, MW - 1 - c1), nodeId(r2, MW - 1 - c2), len, ei]);
  });
  // Doors (top/bottom on both sides, and the side doors) lead out; the tunnel joins its two ends.
  for (const [r, c] of [[1, DOOR_COLS[0]], [20, DOOR_COLS[0]], [1, MW - 1 - DOOR_COLS[0]], [20, MW - 1 - DOOR_COLS[0]], [SIDE_DOOR_ROW, 1], [SIDE_DOOR_ROW, MW - 2]]) {
    list.push([nodeId(r, c), OUT, 1, -1]);
  }
  list.push([nodeId(TUNNEL_ROW, 1), nodeId(TUNNEL_ROW, MW - 2), 3, -1]);
  const n = id.size;
  const adj: [number, number, number][][] = Array.from({ length: n }, () => []);
  list.forEach(([a, b, len], i) => { adj[a].push([b, len, i]); adj[b].push([a, len, i]); });
  const dist = new Int32Array(n);
  const buckets: number[][] = [];
  const live = (i: number) => list[i][3] < 0 || edges[list[i][3]].on;
  return (maxLoop: number) => {
    // Corridor lengths are small integers, so a bucket queue (Dial's algorithm) is fast,
    // and each search stops as soon as it passes the length budget.
    for (const skip of checkList) {
      if (!live(skip)) continue;
      const [a, b, len] = list[skip];
      const limit = maxLoop - len;
      if (limit < 0) return false;
      dist.fill(0x7fffffff);
      dist[a] = 0;
      for (let i = 0; i <= limit; i++) (buckets[i] ??= []).length = 0;
      buckets[0].push(a);
      let found = false;
      for (let d = 0; d <= limit && !found; d++) {
        for (const u of buckets[d]) {
          if (dist[u] !== d) continue;
          if (u === b) { found = true; break; }
          for (const [v, l, ei] of adj[u]) {
            const nd = d + l;
            if (ei === skip || nd >= dist[v] || nd > limit || !live(ei)) continue;
            dist[v] = nd;
            buckets[nd].push(v);
          }
        }
      }
      if (!found) return false;
    }
    return true;
  };
}

function sectorsOk(edges: Edge[], need: number): boolean {
  const on = new Set(edges.filter((e) => e.on && e.b !== null).map((e) => `${e.a}>${e.b}`));
  const count = (list: string[]) => list.reduce((n, k) => n + (on.has(k) ? 1 : 0), 0);
  return count(CROSS_LEFT_MIDDLE_TOP) >= need && count(CROSS_LEFT_MIDDLE_BOTTOM) >= need && count(CROSS_LEFT_TOP_BOTTOM) >= need;
}
const nodeExists = (r: number, c: number) => !(r === 10 && c === 18);

function buildGraph(): { nodes: string[]; edges: Edge[]; external: Map<string, number> } {
  const nodes: string[] = [];
  for (const r of ROWS) for (const c of COLS) if (nodeExists(r, c)) nodes.push(key(r, c));
  const fixed = new Set([
    'v7,15', 'v10,15', 'h7,15', 'h13,15', 'c7', 'c13',
  ]);
  const edges: Edge[] = [];
  for (const r of ROWS) {
    for (let i = 0; i < COLS.length - 1; i++) {
      const c1 = COLS[i], c2 = COLS[i + 1];
      if (!nodeExists(r, c1) || !nodeExists(r, c2)) continue;
      edges.push({ a: key(r, c1), b: key(r, c2), fixed: fixed.has(`h${r},${c1}`), on: true });
    }
    if (nodeExists(r, 18)) edges.push({ a: key(r, 18), b: null, fixed: fixed.has(`c${r}`), on: true });
  }
  for (const c of COLS) {
    for (let j = 0; j < ROWS.length - 1; j++) {
      const r1 = ROWS[j], r2 = ROWS[j + 1];
      if (!nodeExists(r1, c) || !nodeExists(r2, c)) continue;
      if (c === 18 && (r1 === 10 || r2 === 10)) continue;
      edges.push({ a: key(r1, c), b: key(r2, c), fixed: fixed.has(`v${r1},${c}`), on: true });
    }
  }
  // Connections that leave the lattice (doors and tunnel) count toward a node's degree.
  const external = new Map<string, number>([
    [key(1, DOOR_COLS[0]), 1],
    [key(20, DOOR_COLS[0]), 1],
    [key(SIDE_DOOR_ROW, 1), 1],
    [key(TUNNEL_ROW, 1), 1],
  ]);
  return { nodes, edges, external };
}

function degree(n: string, edges: Edge[], external: Map<string, number>): number {
  let d = external.get(n) ?? 0;
  for (const e of edges) if (e.on && (e.a === n || e.b === n)) d++;
  return d;
}

function connected(nodes: string[], edges: Edge[]): boolean {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) {
    if (!e.on || e.b === null) continue;
    adj.get(e.a)!.push(e.b);
    adj.get(e.b)!.push(e.a);
  }
  const seen = new Set<string>([nodes[0]]);
  const stack = [nodes[0]];
  while (stack.length) {
    const n = stack.pop()!;
    for (const m of adj.get(n)!) if (!seen.has(m)) { seen.add(m); stack.push(m); }
  }
  return seen.size === nodes.length;
}

function carveLayout(edges: Edge[]): Uint8Array {
  const tiles = new Uint8Array(MW * MH); // all walls
  const set = (r: number, c: number, t: number) => {
    tiles[r * MW + c] = t;
    tiles[r * MW + (MW - 1 - c)] = t;
  };
  const parse = (k: string) => k.split(',').map(Number) as [number, number];
  for (const e of edges) {
    if (!e.on) continue;
    const [r1, c1] = parse(e.a);
    if (e.b === null) {
      for (let c = c1; c <= MW / 2 - 1; c++) set(r1, c, T_OPEN);
      continue;
    }
    const [r2, c2] = parse(e.b);
    for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++)
      for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) set(r, c, T_OPEN);
  }
  // Doors and tunnel on the border.
  set(0, DOOR_COLS[0], T_OPEN);
  set(MH - 1, DOOR_COLS[0], T_OPEN);
  for (let r = 1; r <= 1; r++) set(r, DOOR_COLS[0], T_OPEN);
  for (let r = 20; r <= MH - 1; r++) set(r, DOOR_COLS[0], T_OPEN);
  set(SIDE_DOOR_ROW, 0, T_OPEN);
  set(TUNNEL_ROW, 0, T_TUNNEL);
  // Ghost house: walls already; carve interior and gate.
  for (let r = HOUSE.top + 1; r < HOUSE.bottom; r++)
    for (let c = HOUSE.left + 1; c < HOUSE.right; c++) tiles[r * MW + c] = T_HOUSE;
  tiles[HOUSE.top * MW + MW / 2 - 1] = T_GATE;
  tiles[HOUSE.top * MW + MW / 2] = T_GATE;
  return tiles;
}

const isBorder = (r: number, c: number) => r === 0 || c === 0 || r === MH - 1 || c === MW - 1;
const inRing = (r: number, c: number) => r >= RING.top && r <= RING.bottom && c >= RING.left && c <= RING.right;

export function isWalkableCode(t: number): boolean {
  return t === T_OPEN || t === T_TUNNEL;
}

function validate(tiles: Uint8Array, dotCount: number): boolean {
  if (dotCount < 230 || dotCount > 360) return false;
  const open = (r: number, c: number) => r < 0 || c < 0 || r >= MH || c >= MW || isWalkableCode(tiles[r * MW + c]);
  let start = -1;
  let total = 0;
  for (let r = 0; r < MH; r++) {
    for (let c = 0; c < MW; c++) {
      if (!isWalkableCode(tiles[r * MW + c])) continue;
      total++;
      if (start < 0) start = r * MW + c;
      if (isBorder(r, c)) continue;
      let n = 0;
      if (open(r - 1, c)) n++;
      if (open(r + 1, c)) n++;
      if (open(r, c - 1)) n++;
      if (open(r, c + 1)) n++;
      if (n < 2) return false; // dead end
      // no 2x2 open blocks
      if (r + 1 < MH && c + 1 < MW && open(r + 1, c) && open(r, c + 1) && open(r + 1, c + 1)) return false;
    }
  }
  // Every walkable tile reachable.
  const seen = new Uint8Array(MW * MH);
  const stack = [start];
  seen[start] = 1;
  let count = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const r = Math.floor(i / MW), c = i % MW;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= MH || nc >= MW) continue;
      const j = nr * MW + nc;
      if (!seen[j] && isWalkableCode(tiles[j])) { seen[j] = 1; count++; stack.push(j); }
    }
  }
  return count === total;
}

export function generateMaze(rng: Rng, sectorPassages = SECTOR_PASSAGES, maxLoop = MAX_ESCAPE_LOOP): MazeLayout {
  for (let attempt = 0; attempt < 200; attempt++) {
    const seed = rng.int(2 ** 31);
    const local = new Rng(seed);
    const { nodes, edges, external } = buildGraph();
    const pRemove = local.range(0.42, 0.62);
    const loopsOk = makeLoopChecker(edges);
    const order = local.shuffle(edges.filter((e) => !e.fixed));
    for (const e of order) {
      if (!local.chance(pRemove)) continue;
      e.on = false;
      const ok = degree(e.a, edges, external) >= 2 && (e.b === null || degree(e.b, edges, external) >= 2) &&
        connected(nodes, edges) && sectorsOk(edges, sectorPassages) && loopsOk(maxLoop);
      if (!ok) e.on = true;
    }
    const tiles = carveLayout(edges);
    const pellets = new Uint8Array(MW * MH);
    const dotTiles: number[] = [];
    const powerTiles: number[] = [];
    for (let r = 0; r < MH; r++) {
      for (let c = 0; c < MW; c++) {
        const i = r * MW + c;
        if (tiles[i] !== T_OPEN || isBorder(r, c) || inRing(r, c)) continue;
        pellets[i] = P_DOT;
      }
    }
    for (const [r, c] of [[1, 1], [20, 1], [1, MW - 2], [20, MW - 2]]) {
      const i = r * MW + c;
      pellets[i] = P_POWER;
    }
    for (let i = 0; i < pellets.length; i++) {
      if (pellets[i] === P_DOT) dotTiles.push(i);
      else if (pellets[i] === P_POWER) powerTiles.push(i);
    }
    if (!validate(tiles, dotTiles.length)) continue;
    return { tiles, pellets, dotCount: dotTiles.length, dotTiles, powerTiles, seed };
  }
  throw new Error('maze generation failed');
}

export function mazeToAscii(m: MazeLayout): string {
  const ch = ['#', '.', '-', ' ', '~'];
  let out = '';
  for (let r = 0; r < MH; r++) {
    for (let c = 0; c < MW; c++) {
      const i = r * MW + c;
      const t = m.tiles[i];
      out += t === T_OPEN ? (m.pellets[i] === P_POWER ? 'o' : m.pellets[i] === P_DOT ? '.' : ' ') : ch[t];
    }
    out += '\n';
  }
  return out;
}
