// server/main.ts
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

// src/config.ts
var GRID = 5;
var MW = 40;
var MH = 22;
var WORLD_W = GRID * MW;
var WORLD_H = GRID * MH;
var PLAYERS = GRID * GRID;
var DOOR_COLS = [9, MW - 1 - 9];
var SIDE_DOOR_ROW = 7;
var TUNNEL_ROW = 16;
var SPAWN = { x: 19.5, y: 13 };
var FRUIT = { x: 19.5, y: 7 };
var HOUSE_EXIT = { x: 19, y: 7 };
var HOUSE_CENTER = { x: 19.5, y: 10 };
var TICK = 1 / 60;
var COUNTDOWN = 3;
var PAC_SPEED_BASE = 10;
var PAC_SPEED_PER_LEVEL = 0.75;
var GHOST_SPEED_FACTOR = [0, 0.7, 0.76, 0.83, 0.9, 0.97];
var GHOST_LEAVE_FACTOR = 0.3;
var GHOST_EMERGE_FACTOR = 0.55;
var GHOST_EMERGE_TIME = 1.2;
var GHOST_FRIGHT_FACTOR = 0.55;
var GHOST_TUNNEL_FACTOR = 0.5;
var GHOST_EYES_FACTOR = 2;
var FRENZY_FACTOR = 1.1;
var ELROY_FACTOR = 1.08;
var ELROY_PELLETS = [0, 20, 30, 40, 50, 60];
var RAIDER_SPEED_FACTOR = 0.72;
var FRIGHT_TIME = [0, 7, 6.5, 6, 5.5, 5];
var SCATTER_TIME = 5;
var CHASE_TIME = 20;
var GHOST_RELEASE = [3, 7, 11, 15];
var RESPAWN_RELEASE_DELAY = 2.5;
var EATEN_REENTER = 5;
var HITSTOP = 0.4;
var DEATH_TIME = 1.5;
var RESPAWN_INVULN = 2;
var RAIDER_LIFE = 15;
var RAIDER_MATERIALIZE = 1;
var RAIDER_THAW_GRACE = 0.5;
var MAX_RAIDERS_PER_MAZE = 4;
var RAIDER_MIN_PATH = 10;
var RAIDER_CHASE_CHANCE = 0.7;
var COLLAPSE_COUNTDOWN = 10;
var LIVES = 3;
var MAX_LEVEL = 5;
var CHARGE_FULL = 240;
var CHARGE_HOME = 1;
var CHARGE_AWAY = 2;
var AIRDROP_EVERY = 30;
var MAX_AIRDROPS = 2;
var POWERUP_WARN = 1;
var BLACKOUT_TIME = 8;
var FRENZY_TIME = 10;
var DAZE_TIME = 4;
var DAZE_CHARGE = 1;
var OVERTIME_START = 7 * 60;
var OVERTIME_EVERY = 40;
var MAX_GHOSTS_PER_MAZE = 8;
var COLLIDE_DIST = 0.6;
var EMPTY_QUADRANT_CHANCE = 0.8;
var EMPTY_BOARD_AFTER_FULL = 0.5;
var EMPTY_BOARD_FRUIT_DELAY = 2;
var CORNER_CUT = 0.35;
var PHASE_TIME = 0.3;
var PHASE_COOLDOWN = 1.2;
var PHASE_HITSTOP = 0.12;
var PLAYER_COLORS = [
  "#FFD84A",
  // human
  "#E04FBF",
  "#D9894A",
  "#5FD3FF",
  "#8CF06A",
  "#B88CFF",
  "#FF6F7D",
  "#4FE3B5",
  "#F5A3FF",
  "#C9D86B",
  "#7FA6FF",
  "#FFB36B",
  "#6BE0E0",
  "#E8E8F0",
  "#FF8FC2",
  "#A3E37A",
  "#9C9CFF",
  "#FFCF8F",
  "#62C7A0",
  "#E37ADE",
  "#88B7D9",
  "#D9B36B",
  "#B4F0D2",
  "#F07A5A",
  "#C0A0E0"
];
var BOT_NAMES = [
  "NOVA",
  "VEX",
  "KRAIT",
  "RIFT",
  "ONYX",
  "PIXEL",
  "ZED",
  "LUMEN",
  "BYTE",
  "ECHO",
  "FLUX",
  "HALO",
  "JINX",
  "KILO",
  "MOTH",
  "NEON",
  "ORBIT",
  "PRISM",
  "QUARK",
  "RUNE",
  "SABLE",
  "TONIC",
  "VOLT",
  "WISP",
  "AXLE"
];

// src/rng.ts
var Rng = class {
  s;
  constructor(seed) {
    this.s = seed >>> 0 || 2654435769;
  }
  next() {
    let t = this.s = this.s + 1831565813 >>> 0;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
  int(n) {
    return Math.floor(this.next() * n);
  }
  range(a, b) {
    return a + (b - a) * this.next();
  }
  pick(arr) {
    return arr[this.int(arr.length)];
  }
  chance(p) {
    return this.next() < p;
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  weighted(items, weights) {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r < 0) return items[i];
    }
    return items[items.length - 1];
  }
};

// src/maze.ts
var T_WALL = 0;
var T_OPEN = 1;
var T_GATE = 2;
var T_HOUSE = 3;
var T_TUNNEL = 4;
var P_DOT = 1;
var P_POWER = 2;
var ROWS = [1, 4, 7, 10, 13, 16, 20];
var COLS = [1, 5, 9, 12, 15, 18];
var HOUSE = { top: 8, bottom: 12, left: 16, right: MW - 1 - 16 };
var RING = { top: 7, bottom: 13, left: 15, right: MW - 1 - 15 };
var key = (r, c) => `${r},${c}`;
var SECTOR_PASSAGES = 1;
var MAX_ESCAPE_LOOP = 30;
var CROSS_LEFT_MIDDLE_TOP = [1, 4, 7, 10].map((r) => `${key(r, 12)}>${key(r, 15)}`);
var CROSS_LEFT_MIDDLE_BOTTOM = [13, 16, 20].map((r) => `${key(r, 12)}>${key(r, 15)}`);
var CROSS_LEFT_TOP_BOTTOM = [1, 5, 9, 12].map((c) => `${key(10, c)}>${key(13, c)}`);
function makeLoopChecker(edges) {
  const parse = (k) => k.split(",").map(Number);
  const id = /* @__PURE__ */ new Map();
  const nodeId = (r, c) => {
    const k = key(r, c);
    let v = id.get(k);
    if (v === void 0) {
      v = id.size;
      id.set(k, v);
    }
    return v;
  };
  const list = [];
  const checkList = [];
  edges.forEach((e, ei) => {
    const [r1, c1] = parse(e.a);
    if (e.b === null) {
      checkList.push(list.length);
      list.push([nodeId(r1, c1), nodeId(r1, MW - 1 - c1), MW - 1 - 2 * c1, ei]);
      return;
    }
    const [r22, c2] = parse(e.b);
    const len = Math.abs(r22 - r1) + Math.abs(c2 - c1);
    checkList.push(list.length);
    list.push([nodeId(r1, c1), nodeId(r22, c2), len, ei]);
    list.push([nodeId(r1, MW - 1 - c1), nodeId(r22, MW - 1 - c2), len, ei]);
  });
  list.push([nodeId(TUNNEL_ROW, 1), nodeId(TUNNEL_ROW, MW - 2), 3, -1]);
  const n = id.size;
  const adj = Array.from({ length: n }, () => []);
  list.forEach(([a, b, len], i) => {
    adj[a].push([b, len, i]);
    adj[b].push([a, len, i]);
  });
  const dist3 = new Int32Array(n);
  const buckets2 = [];
  const live = (i) => list[i][3] < 0 || edges[list[i][3]].on;
  return (maxLoop) => {
    for (const skip of checkList) {
      if (!live(skip)) continue;
      const [a, b, len] = list[skip];
      const limit = maxLoop - len;
      if (limit < 0) return false;
      dist3.fill(2147483647);
      dist3[a] = 0;
      for (let i = 0; i <= limit; i++) (buckets2[i] ??= []).length = 0;
      buckets2[0].push(a);
      let found = false;
      for (let d = 0; d <= limit && !found; d++) {
        for (const u of buckets2[d]) {
          if (dist3[u] !== d) continue;
          if (u === b) {
            found = true;
            break;
          }
          for (const [v, l, ei] of adj[u]) {
            const nd = d + l;
            if (ei === skip || nd >= dist3[v] || nd > limit || !live(ei)) continue;
            dist3[v] = nd;
            buckets2[nd].push(v);
          }
        }
      }
      if (!found) return false;
    }
    return true;
  };
}
function sectorsOk(edges, need) {
  const on = new Set(edges.filter((e) => e.on && e.b !== null).map((e) => `${e.a}>${e.b}`));
  const count = (list) => list.reduce((n, k) => n + (on.has(k) ? 1 : 0), 0);
  return count(CROSS_LEFT_MIDDLE_TOP) >= need && count(CROSS_LEFT_MIDDLE_BOTTOM) >= need && count(CROSS_LEFT_TOP_BOTTOM) >= need;
}
var nodeExists = (r, c) => !(r === 10 && c === 18);
function buildGraph() {
  const nodes = [];
  for (const r of ROWS) for (const c of COLS) if (nodeExists(r, c)) nodes.push(key(r, c));
  const fixed = /* @__PURE__ */ new Set([
    "v7,15",
    "v10,15",
    "h7,15",
    "h13,15",
    "c7",
    "c13"
  ]);
  const edges = [];
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
      const r1 = ROWS[j], r22 = ROWS[j + 1];
      if (!nodeExists(r1, c) || !nodeExists(r22, c)) continue;
      if (c === 18 && (r1 === 10 || r22 === 10)) continue;
      edges.push({ a: key(r1, c), b: key(r22, c), fixed: fixed.has(`v${r1},${c}`), on: true });
    }
  }
  const external = /* @__PURE__ */ new Map([
    [key(1, DOOR_COLS[0]), 1],
    [key(20, DOOR_COLS[0]), 1],
    [key(SIDE_DOOR_ROW, 1), 1],
    [key(TUNNEL_ROW, 1), 1]
  ]);
  return { nodes, edges, external };
}
function degree(n, edges, external) {
  let d = external.get(n) ?? 0;
  for (const e of edges) if (e.on && (e.a === n || e.b === n)) d++;
  return d;
}
function connected(nodes, edges) {
  const adj = /* @__PURE__ */ new Map();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) {
    if (!e.on || e.b === null) continue;
    adj.get(e.a).push(e.b);
    adj.get(e.b).push(e.a);
  }
  const seen = /* @__PURE__ */ new Set([nodes[0]]);
  const stack = [nodes[0]];
  while (stack.length) {
    const n = stack.pop();
    for (const m of adj.get(n)) if (!seen.has(m)) {
      seen.add(m);
      stack.push(m);
    }
  }
  return seen.size === nodes.length;
}
function carveLayout(edges) {
  const tiles = new Uint8Array(MW * MH);
  const set = (r, c, t) => {
    tiles[r * MW + c] = t;
    tiles[r * MW + (MW - 1 - c)] = t;
  };
  const parse = (k) => k.split(",").map(Number);
  for (const e of edges) {
    if (!e.on) continue;
    const [r1, c1] = parse(e.a);
    if (e.b === null) {
      for (let c = c1; c <= MW / 2 - 1; c++) set(r1, c, T_OPEN);
      continue;
    }
    const [r22, c2] = parse(e.b);
    for (let r = Math.min(r1, r22); r <= Math.max(r1, r22); r++)
      for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) set(r, c, T_OPEN);
  }
  set(0, DOOR_COLS[0], T_OPEN);
  set(MH - 1, DOOR_COLS[0], T_OPEN);
  for (let r = 1; r <= 1; r++) set(r, DOOR_COLS[0], T_OPEN);
  for (let r = 20; r <= MH - 1; r++) set(r, DOOR_COLS[0], T_OPEN);
  set(SIDE_DOOR_ROW, 0, T_OPEN);
  set(TUNNEL_ROW, 0, T_TUNNEL);
  for (let r = HOUSE.top + 1; r < HOUSE.bottom; r++)
    for (let c = HOUSE.left + 1; c < HOUSE.right; c++) tiles[r * MW + c] = T_HOUSE;
  tiles[HOUSE.top * MW + MW / 2 - 1] = T_GATE;
  tiles[HOUSE.top * MW + MW / 2] = T_GATE;
  return tiles;
}
var isBorder = (r, c) => r === 0 || c === 0 || r === MH - 1 || c === MW - 1;
var inRing = (r, c) => r >= RING.top && r <= RING.bottom && c >= RING.left && c <= RING.right;
function isWalkableCode(t) {
  return t === T_OPEN || t === T_TUNNEL;
}
function validate(tiles, dotCount) {
  if (dotCount < 230 || dotCount > 360) return false;
  const open = (r, c) => r < 0 || c < 0 || r >= MH || c >= MW || isWalkableCode(tiles[r * MW + c]);
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
      if (n < 2) return false;
      if (r + 1 < MH && c + 1 < MW && open(r + 1, c) && open(r, c + 1) && open(r + 1, c + 1)) return false;
    }
  }
  const seen = new Uint8Array(MW * MH);
  const stack = [start];
  seen[start] = 1;
  let count = 1;
  while (stack.length) {
    const i = stack.pop();
    const r = Math.floor(i / MW), c = i % MW;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= MH || nc >= MW) continue;
      const j = nr * MW + nc;
      if (!seen[j] && isWalkableCode(tiles[j])) {
        seen[j] = 1;
        count++;
        stack.push(j);
      }
    }
  }
  return count === total;
}
function generateMaze(rng, sectorPassages = SECTOR_PASSAGES, maxLoop = MAX_ESCAPE_LOOP) {
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
      const ok = degree(e.a, edges, external) >= 2 && (e.b === null || degree(e.b, edges, external) >= 2) && connected(nodes, edges) && sectorsOk(edges, sectorPassages) && loopsOk(maxLoop);
      if (!ok) e.on = true;
    }
    const tiles = carveLayout(edges);
    const pellets = new Uint8Array(MW * MH);
    const dotTiles = [];
    const powerTiles = [];
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
  throw new Error("maze generation failed");
}

// src/movement.ts
var LEFT = 1;
var RIGHT = 3;
var DX = [0, -1, 0, 1];
var DY = [-1, 0, 1, 0];
var opposite = (d) => d < 0 ? -1 : (d + 2) % 4;
var wrapX = (x) => (x % WORLD_W + WORLD_W) % WORLD_W;
var wrapY = (y) => (y % WORLD_H + WORLD_H) % WORLD_H;
function wrapDelta(d, size) {
  if (d > size / 2) return d - size;
  if (d < -size / 2) return d + size;
  return d;
}
function dist2(ax, ay, bx, by) {
  const dx = wrapDelta(ax - bx, WORLD_W);
  const dy = wrapDelta(ay - by, WORLD_H);
  return dx * dx + dy * dy;
}
var EPS = 1e-6;
function move(m, dist3, opt) {
  let guard = 0;
  let stopped = false;
  let justWarped = false;
  while (dist3 > EPS && guard++ < 16) {
    const cx = Math.round(m.x), cy = Math.round(m.y);
    const atC = Math.abs(m.x - cx) < EPS && Math.abs(m.y - cy) < EPS;
    if (atC) {
      m.x = cx;
      m.y = cy;
      if (!justWarped) opt.atCenter?.(m);
      justWarped = false;
      const lx = (cx % MW + MW) % MW;
      const tunnelRow = opt.tunnel && (cy % MH + MH) % MH === TUNNEL_ROW;
      const warpDir = tunnelRow ? lx === 0 ? LEFT : lx === MW - 1 ? RIGHT : -1 : -1;
      const canGo = (d) => d === warpDir || opt.canEnter(cx + DX[d], cy + DY[d]);
      if (m.next >= 0 && canGo(m.next)) m.dir = m.next;
      if (m.dir >= 0 && m.dir === warpDir) {
        m.x = wrapX(cx + (m.dir === LEFT ? MW - 1 : -(MW - 1)));
        justWarped = true;
        continue;
      }
      if (m.dir < 0 || !opt.canEnter(cx + DX[m.dir], cy + DY[m.dir])) {
        stopped = true;
        break;
      }
      const step = Math.min(dist3, 1);
      m.x += DX[m.dir] * step;
      m.y += DY[m.dir] * step;
      dist3 -= step;
      if (step === 1) {
        m.x = Math.round(m.x);
        m.y = Math.round(m.y);
      }
    } else {
      if (m.dir < 0) {
        m.x = cx;
        m.y = cy;
        continue;
      }
      if (m.next >= 0 && m.next === opposite(m.dir)) m.dir = m.next;
      const horiz = DX[m.dir] !== 0;
      const p = horiz ? m.x : m.y;
      const s = DX[m.dir] + DY[m.dir];
      const d = s > 0 ? Math.ceil(p - EPS) - p : p - Math.floor(p + EPS);
      if (opt.cornerCut && m.next >= 0 && m.next !== m.dir && m.next !== opposite(m.dir) && d <= opt.cornerCut) {
        const ncx = horiz ? Math.round(m.x + s * d) : Math.round(m.x);
        const ncy = horiz ? Math.round(m.y) : Math.round(m.y + s * d);
        if (opt.canEnter(ncx + DX[m.next], ncy + DY[m.next])) {
          const fx = m.x, fy = m.y, fdir = m.dir;
          m.x = wrapX(ncx);
          m.y = wrapY(ncy);
          opt.onCorner?.(d, fx, fy, fdir);
          continue;
        }
      }
      const step = Math.min(dist3, d);
      if (horiz) m.x += s * step;
      else m.y += s * step;
      dist3 -= step;
      if (step >= d - EPS) {
        m.x = Math.round(m.x);
        m.y = Math.round(m.y);
      }
    }
    m.x = wrapX(m.x);
    m.y = wrapY(m.y);
  }
  m.x = wrapX(m.x);
  m.y = wrapY(m.y);
  return stopped;
}

// src/ghosts.ts
function nearestPac(game, maze, x, y) {
  let best = null, bd = Infinity;
  for (const p of game.inMaze[maze]) {
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}
function options(m, canEnter) {
  const cx = Math.round(m.x), cy = Math.round(m.y);
  const rev = opposite(m.dir);
  const out = [];
  for (let d = 0; d < 4; d++) if (d !== rev && canEnter(cx + DX[d], cy + DY[d])) out.push(d);
  if (out.length === 0 && rev >= 0 && canEnter(cx + DX[rev], cy + DY[rev])) out.push(rev);
  return out;
}
function towards(m, opts, tx, ty) {
  const cx = Math.round(m.x), cy = Math.round(m.y);
  let best = opts[0], bd = Infinity;
  for (const d of opts) {
    const nx = cx + DX[d], ny = cy + DY[d];
    const dd = (nx - tx) ** 2 + (ny - ty) ** 2;
    if (dd < bd) {
      bd = dd;
      best = d;
    }
  }
  return best;
}
var homeDist = /* @__PURE__ */ new WeakMap();
function homeField(game, maze) {
  const layout = game.mazes[maze].layout;
  let d = homeDist.get(layout);
  if (d) return d;
  d = new Int16Array(MW * MH).fill(-1);
  const start = HOUSE_EXIT.y * MW + HOUSE_EXIT.x;
  d[start] = 0;
  const q = [start];
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    const x = i % MW, y = Math.floor(i / MW);
    for (let k = 0; k < 4; k++) {
      const nx = x + DX[k], ny = y + DY[k];
      if (nx < 0 || ny < 0 || nx >= MW || ny >= MH) continue;
      const j = ny * MW + nx;
      if (d[j] >= 0 || !isWalkableCode(layout.tiles[j])) continue;
      d[j] = d[i] + 1;
      q.push(j);
    }
  }
  homeDist.set(layout, d);
  return d;
}
function chooseGhostDir(game, g, canEnter) {
  const m = game.mazes[g.maze];
  if (g.state === "eyes") {
    const field = homeField(game, g.maze);
    const cx = Math.round(g.x), cy = Math.round(g.y);
    let best = -1, bd = Infinity;
    for (let k = 0; k < 4; k++) {
      if (!canEnter(cx + DX[k], cy + DY[k])) continue;
      const lx = cx + DX[k] - m.ox, ly = cy + DY[k] - m.oy;
      if (lx < 0 || ly < 0 || lx >= MW || ly >= MH) continue;
      const v = field[ly * MW + lx];
      if (v >= 0 && v < bd) {
        bd = v;
        best = k;
      }
    }
    g.next = best;
    if (best >= 0) g.dir = best;
    return;
  }
  const opts = options(g, canEnter);
  if (opts.length === 0) {
    g.next = -1;
    return;
  }
  if (game.isFrightened(g)) {
    g.next = game.rng.pick(opts);
    return;
  }
  const pac = nearestPac(game, g.maze, g.x, g.y);
  const elroy = g.kind === 0 && m.dotsLeft <= ELROY_PELLETS[m.level];
  const chase = pac && (m.mode === "chase" || m.frenzy > 0 || elroy);
  let tx, ty;
  const corners = [[MW - 2, -3], [1, -3], [MW - 2, MH + 2], [1, MH + 2]];
  if (!chase || !pac) {
    tx = m.ox + corners[g.kind][0];
    ty = m.oy + corners[g.kind][1];
  } else {
    const px = Math.round(pac.x), py = Math.round(pac.y);
    const f = pac.face >= 0 ? pac.face : 0;
    switch (g.kind) {
      case 0:
        tx = px;
        ty = py;
        break;
      case 1:
        tx = px + DX[f] * 4;
        ty = py + DY[f] * 4;
        break;
      case 2: {
        const ax = px + DX[f] * 2, ay = py + DY[f] * 2;
        const lead = game.ghosts.find((o) => o.maze === g.maze && o.kind === 0 && o.state === "active");
        const bx = lead ? Math.round(lead.x) : px, by = lead ? Math.round(lead.y) : py;
        tx = ax + (ax - bx);
        ty = ay + (ay - by);
        break;
      }
      default: {
        const d2 = (px - g.x) ** 2 + (py - g.y) ** 2;
        if (d2 > 64) {
          tx = px;
          ty = py;
        } else {
          tx = m.ox + corners[3][0];
          ty = m.oy + corners[3][1];
        }
      }
    }
  }
  g.next = towards(g, opts, tx, ty);
}
function chooseRaiderDir(game, r, canEnter) {
  const opts = options(r, canEnter);
  if (opts.length === 0) {
    r.next = -1;
    r.dir = -1;
    return;
  }
  const pac = nearestPac(game, r.maze, r.x, r.y);
  if (pac && game.rng.chance(RAIDER_CHASE_CHANCE)) r.next = towards(r, opts, Math.round(pac.x), Math.round(pac.y));
  else r.next = game.rng.pick(opts);
  if (r.dir < 0) r.dir = r.next;
}

// src/bots.ts
var N = WORLD_W * WORLD_H;
var stamp = new Int32Array(N);
var dist = new Int16Array(N);
var first = new Int8Array(N);
var tStamp = new Int32Array(N);
var tDist = new Int32Array(N);
var queue = new Int32Array(N);
var gen = 0;
var tGen = 0;
var MAX_DEPTH = 40;
var MAX_NODES = 5e3;
var REGION_DEPTH = 16;
var THREAT_DEPTH = 16;
var botDebug = { name: "", log: [] };
function makeBrain(rng) {
  return {
    skill: rng.range(0.45, 0.95),
    aggression: rng.range(0.2, 1),
    useDelay: rng.range(1, 5),
    goalMaze: -1,
    goalX: 0,
    goalY: 0,
    goalTimer: 0,
    thinkTimer: 0,
    lastReverse: -10
  };
}
function walkable(game, x, y) {
  const mi = Math.floor(x / MW) + Math.floor(y / MH) * GRID;
  const m = game.mazes[mi];
  if (m.collapsed) return false;
  return isWalkableCode(m.layout.tiles[y % MH * MW + x % MW]);
}
var UNIT = 10;
var mazeOf = (x, y) => Math.floor(x / MW) + Math.floor(y / MH) * GRID;
function gatherThreats(game, p, radius, blind) {
  const out = [];
  const near = (x, y) => !blind && mazeOf(wrapX(Math.round(x)), wrapY(Math.round(y))) === p.maze || Math.abs(wrapDelta(x - p.x, WORLD_W)) <= radius && Math.abs(wrapDelta(y - p.y, WORLD_H)) <= radius;
  const pac = (maze) => game.pacSpeed(game.mazes[maze].level);
  const units = (seconds, maze) => Math.round(seconds * pac(maze) * UNIT);
  for (const g of game.ghosts) {
    const m = game.mazes[g.maze];
    const step = Math.min(UNIT, Math.round(UNIT / game.ghostChaseRatio(g)));
    if (g.state === "house" || g.state === "leaving") {
      const ex = m.ox + HOUSE_EXIT.x, ey = m.oy + HOUSE_EXIT.y;
      const crawl = (Math.abs(g.x - (m.ox + HOUSE_CENTER.x)) + Math.abs(g.y - ey) + 0.5) / (pac(g.maze) * GHOST_LEAVE_FACTOR);
      const wait = (g.state === "house" ? Math.max(0, g.timer) : 0) + crawl;
      if (wait < 3 && near(ex, ey)) out.push({ x: ex, y: ey, delay: units(wait, g.maze), step });
      continue;
    }
    if (g.state !== "active" || !near(g.x, g.y)) continue;
    const delay = game.isFrightened(g) ? units(m.frightTimer, g.maze) : 0;
    out.push({ x: g.x, y: g.y, delay, step, dir: g.dir });
  }
  for (const r of game.raiders) {
    if (r.dead || !near(r.x, r.y)) continue;
    const m = game.mazes[r.maze];
    const wait = Math.max(r.materialize, m.frightTimer + (m.frightTimer > 0 ? RAIDER_THAW_GRACE : r.grace), 0);
    const step = Math.round(UNIT * pac(r.maze) / (PAC_SPEED_BASE * RAIDER_SPEED_FACTOR));
    out.push({ x: r.x, y: r.y, delay: units(wait, r.maze), step, dir: r.dir });
  }
  return out;
}
var MAX_UNITS = THREAT_DEPTH * UNIT;
var buckets = [];
var tStep = new Uint8Array(N);
function threatField(game, threats, self) {
  tGen++;
  tStamp[self] = tGen;
  tDist[self] = 0;
  for (let i = 0; i <= MAX_UNITS; i++) (buckets[i] ??= []).length = 0;
  for (const t of threats) {
    const d0 = Math.max(0, t.delay);
    if (d0 > MAX_UNITS) continue;
    const lead = t.dir !== void 0 && t.dir >= 0 ? 0.49 : 0;
    const tx = Math.round(t.x + (lead ? DX[t.dir] * lead : 0));
    const ty = Math.round(t.y + (lead ? DY[t.dir] * lead : 0));
    const k = wrapY(ty) * WORLD_W + wrapX(tx);
    if (k === self) continue;
    if (tStamp[k] === tGen && tDist[k] <= d0) continue;
    tStamp[k] = tGen;
    tDist[k] = d0;
    tStep[k] = t.step;
    buckets[d0].push(k);
  }
  for (let d = 0; d < MAX_UNITS; d++) {
    const list = buckets[d];
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      if (tDist[k] !== d || k === self) continue;
      const step = tStep[k];
      const nd = d + step;
      if (nd > MAX_UNITS) continue;
      const x = k % WORLD_W, y = k / WORLD_W | 0;
      const mz = mazeOf(x, y);
      for (let dir = 0; dir < 4; dir++) {
        let nx = wrapX(x + DX[dir]);
        const ny = wrapY(y + DY[dir]);
        if (ny % MH === TUNNEL_ROW) {
          const lx = x % MW;
          if (lx === 0 && dir === 1) nx = x + MW - 1;
          else if (lx === MW - 1 && dir === 3) nx = x - (MW - 1);
        }
        const nk = ny * WORLD_W + nx;
        if (tStamp[nk] === tGen && tDist[nk] <= nd) continue;
        if (mazeOf(nx, ny) !== mz || !walkable(game, nx, ny)) continue;
        tStamp[nk] = tGen;
        tDist[nk] = nd;
        tStep[nk] = step;
        buckets[nd].push(nk);
      }
    }
  }
}
function pickGoal(game, p, b) {
  const cands = /* @__PURE__ */ new Set([...game.neighborTargets(p.maze), p.home]);
  let best = -1, bs = -Infinity;
  for (const i of cands) {
    const m = game.mazes[i];
    if (m.collapsed || m.collapseTimer > 0) continue;
    let s = m.dotsLeft - m.level * 20 - m.raiderCount * 30 + game.rng.next() * 25;
    if (m.fruit) s += m.owner !== p.id ? 60 + 60 * b.aggression : 40;
    if (i === p.maze) s -= 15;
    if (s > bs) {
      bs = s;
      best = i;
    }
  }
  b.goalMaze = best;
  b.goalTimer = 6 + game.rng.next() * 6;
  if (best >= 0) {
    const m = game.mazes[best];
    const left = m.layout.dotTiles.filter((i2) => m.pellets[i2] !== 0);
    const i = game.rng.pick(left.length ? left : m.layout.dotTiles);
    b.goalX = m.ox + i % MW;
    b.goalY = m.oy + Math.floor(i / MW);
  }
}
function botDecide(game, p) {
  const b = p.bot;
  const cx = Math.round(p.x), cy = Math.round(p.y);
  const here = game.mazes[p.maze];
  const blind = here.blackout > 0;
  const radius = blind ? 3 : Math.round(5 + b.skill * 8);
  const threats = gatherThreats(game, p, radius, blind);
  threatField(game, threats, wrapY(Math.round(p.y)) * WORLD_W + wrapX(Math.round(p.x)));
  const special = /* @__PURE__ */ new Map();
  const key2 = (x, y) => wrapY(Math.round(y)) * WORLD_W + wrapX(Math.round(x));
  const away = p.maze !== p.home;
  for (const g of game.ghosts) {
    if (!game.isFrightened(g)) continue;
    const m = game.mazes[g.maze];
    const reach = Math.abs(wrapDelta(g.x - p.x, WORLD_W)) + Math.abs(wrapDelta(g.y - p.y, WORLD_H));
    if (reach / game.pacSpeed(m.level) > m.frightTimer * 0.85) continue;
    special.set(key2(g.x, g.y), 8 + (away ? 10 * b.aggression : 0));
  }
  for (const m of game.mazes) {
    if (!m.fruit || m.collapsed) continue;
    special.set(key2(m.ox + FRUIT.x, m.oy + FRUIT.y), m.owner === p.id ? 4 : 8 + 14 * b.aggression);
  }
  if (p.slot === null) for (const a of game.airdrops) special.set(key2(a.x, a.y), 7);
  const rivalCharging = game.inMaze[p.maze].some((q) => q !== p && q.dazeCharge > 0);
  const fleeMaze = rivalCharging || here.collapseTimer > 0;
  const threatNear = threats.length > 0;
  gen++;
  const start = cy * WORLD_W + cx;
  stamp[start] = gen;
  dist[start] = 0;
  first[start] = -1;
  let tail = 0;
  queue[tail++] = start;
  const reward = [0, 0, 0, 0];
  const best1 = [0, 0, 0, 0];
  const region = [0, 0, 0, 0];
  const goalScore = [Infinity, Infinity, Infinity, Infinity];
  const reachable = [false, false, false, false];
  const blockedNear = [99, 99, 99, 99];
  if (b.goalTimer <= 0 || b.goalMaze < 0 || game.mazes[b.goalMaze].collapsed) pickGoal(game, p, b);
  const gx = b.goalX, gy = b.goalY;
  if (Math.abs(wrapDelta(cx - gx, WORLD_W)) + Math.abs(wrapDelta(cy - gy, WORLD_H)) < 2) b.goalTimer = 0;
  const margin = b.skill > 0.7 ? 1 : 0;
  for (let h = 0; h < tail; h++) {
    const k = queue[h];
    const d = dist[k];
    const x = k % WORLD_W, y = k / WORLD_W | 0;
    const f = first[k];
    if (f >= 0) {
      const mi = Math.floor(x / MW) + Math.floor(y / MH) * GRID;
      const m = game.mazes[mi];
      const decay = Math.pow(0.88, d);
      const pel = m.pellets[y % MH * MW + x % MW];
      let v = 0;
      if (pel === P_DOT) v += mi === p.home ? 1 : 1.2 + 0.5 * b.aggression;
      else if (pel === P_POWER) v += threatNear ? 12 : 0.4;
      const s = special.get(k);
      if (s) v += s;
      if (m.collapseTimer > 0) v -= 6;
      if (fleeMaze && mi !== p.maze) v += 3;
      if (m.raiderCount > 0 && mi !== p.maze) v -= 0.5;
      reward[f] += v * decay;
      if (v * decay > best1[f]) best1[f] = v * decay;
      if (d <= REGION_DEPTH) region[f]++;
      const gd = Math.abs(wrapDelta(x - gx, WORLD_W)) + Math.abs(wrapDelta(y - gy, WORLD_H));
      const gs = d * 0.35 + gd;
      if (gs < goalScore[f]) goalScore[f] = gs;
    }
    if (d >= MAX_DEPTH) continue;
    for (let dir = 0; dir < 4; dir++) {
      let nx = wrapX(x + DX[dir]);
      const ny = wrapY(y + DY[dir]);
      if (ny % MH === TUNNEL_ROW) {
        const lx = x % MW;
        if (lx === 0 && dir === 1) nx = x + MW - 1;
        else if (lx === MW - 1 && dir === 3) nx = x - (MW - 1);
      }
      const nk = ny * WORLD_W + nx;
      if (tail >= MAX_NODES || stamp[nk] === gen || !walkable(game, nx, ny)) continue;
      const threatHere = tStamp[nk] === tGen ? tDist[nk] : 9999;
      if (f < 0) blockedNear[dir] = threatHere;
      if (threatHere <= (d + 1 + margin) * UNIT) continue;
      stamp[nk] = gen;
      dist[nk] = d + 1;
      first[nk] = f >= 0 ? f : dir;
      if (f < 0) reachable[dir] = true;
      queue[tail++] = nk;
    }
  }
  const totalReward = reward.reduce((a, c) => a + c, 0);
  const fwdOk = p.dir >= 0 && reachable[p.dir] && region[p.dir] >= 10;
  let best = -1, bs = -Infinity;
  for (let dir = 0; dir < 4; dir++) {
    if (!reachable[dir]) continue;
    let s;
    if (totalReward < 0.05) s = -goalScore[dir];
    else s = best1[dir] * 10 + reward[dir] * 0.4;
    if (threatNear) {
      s += Math.min(region[dir], 40) * 0.25 * (0.5 + b.skill);
      if (region[dir] < 25) s -= (25 - region[dir]) * 4 * (0.5 + b.skill);
    }
    if (dir === opposite(p.dir) && fwdOk) s -= (threatNear ? 5 : 3) + (game.time - b.lastReverse < 1.5 ? 60 : 0);
    s += (game.rng.next() - 0.5) * (1.5 - b.skill) * 2;
    if (s > bs) {
      bs = s;
      best = dir;
    }
  }
  if (best < 0) {
    let bd = -1;
    for (let dir = 0; dir < 4; dir++) {
      if (!walkable(game, wrapX(cx + DX[dir]), wrapY(cy + DY[dir]))) continue;
      if (blockedNear[dir] > bd) {
        bd = blockedNear[dir];
        best = dir;
      }
    }
  }
  if (botDebug.name === p.name || botDebug.all) {
    const f = (a) => a.map((v) => v.toFixed(1)).join(",");
    botDebug.log.push(`${botDebug.all ? p.id + "|" : ""}${game.time.toFixed(2)} @${cx % MW},${cy % MH} dir${p.dir} best[${f(best1)}] region[${region}] thr ${threats.map((t) => `(${(t.x % MW).toFixed(1)},${(t.y % MH).toFixed(1)}+${t.delay}/${t.step})`).join("")} -> ${best}`);
  }
  if (best >= 0 && best === opposite(p.dir)) b.lastReverse = game.time;
  if (best >= 0) p.next = best;
}
function botUpdate(game, p, dt) {
  const b = p.bot;
  b.goalTimer -= dt;
  b.thinkTimer -= dt;
  if (b.thinkTimer <= 0 && p.dir >= 0 && p.daze <= 0) {
    b.thinkTimer = 0.1;
    if (p.invuln <= 0 && game.rng.chance(0.35 + b.skill * 0.6)) {
      const ax = p.x + DX[p.dir] * 1.5, ay = p.y + DY[p.dir] * 1.5;
      const deadly = (x, y) => Math.abs(wrapDelta(x - ax, WORLD_W)) < 1.3 && Math.abs(wrapDelta(y - ay, WORLD_H)) < 1.3;
      let hit = false;
      for (const g of game.ghosts) {
        if (g.maze !== p.maze || g.state !== "active" || game.isFrightened(g)) continue;
        if (deadly(g.x, g.y)) {
          hit = true;
          break;
        }
      }
      if (!hit) {
        for (const r of game.raiders) if (r.maze === p.maze && game.raiderHarmful(r) && deadly(r.x, r.y)) {
          hit = true;
          break;
        }
      }
      if (hit) p.next = opposite(p.dir);
    }
  }
  if (p.slot) {
    b.useDelay -= dt;
    if (b.useDelay > 0) return;
    if (p.slot === "daze") {
      const rivals = game.inMaze[p.maze].filter((q) => q !== p && q.invuln <= 0);
      const exposed = rivals.some((q) => game.ghosts.some((g) => g.maze === q.maze && g.state === "active" && !game.isFrightened(g) && Math.abs(g.x - q.x) + Math.abs(g.y - q.y) < 7));
      if (exposed || rivals.length > 0 && b.useDelay < -8) game.usePower(p);
    } else {
      const targets = game.neighborTargets(p.maze).filter((t) => game.inMaze[t].length > 0);
      if (targets.length > 0) game.usePower(p);
    }
    if (!p.slot) b.useDelay = 1 + game.rng.next() * 4;
  }
}

// src/game.ts
var mazeName = (idx) => "ABCDE"[idx % GRID] + (Math.floor(idx / GRID) + 1);
var NET_HOLD = -2;
var Game = class {
  rng;
  seed;
  mazes = [];
  players = [];
  ghosts = [];
  raiders = [];
  airdrops = [];
  events = [];
  // drained by the renderer/audio each frame
  feed = [];
  // recent notable events for the HUD
  time = 0;
  /** Seconds left in the pre-match countdown; nothing moves until it reaches 0. */
  countdown = 0;
  over = false;
  winner = -1;
  humanId = -1;
  airdropTimer = AIRDROP_EVERY;
  overtimeTimer = OVERTIME_EVERY;
  nextId = 1;
  /** Players currently in each maze, rebuilt every tick. */
  inMaze = [];
  // Scratch buffers for BFS (shared by bots and raider spawning).
  bfsStamp = new Int32Array(WORLD_W * WORLD_H);
  bfsDist = new Int16Array(WORLD_W * WORLD_H);
  bfsFirst = new Int8Array(WORLD_W * WORLD_H);
  bfsGen = 0;
  constructor(opts) {
    this.seed = opts.seed;
    this.countdown = opts.countdown ?? 0;
    this.rng = new Rng(opts.seed);
    for (let i = 0; i < GRID * GRID; i++) {
      const layout = generateMaze(this.rng);
      const mx = i % GRID, my = Math.floor(i / GRID);
      this.mazes.push({
        idx: i,
        mx,
        my,
        ox: mx * MW,
        oy: my * MH,
        layout,
        pellets: new Uint8Array(layout.pellets.length),
        dotsLeft: 0,
        level: 1,
        owner: -1,
        collapsed: false,
        collapseTimer: 0,
        frightTimer: 0,
        frightGen: 0,
        hitstop: 0,
        combo: 0,
        board: "full",
        emptyQuadrant: -1,
        fruitTimer: 0,
        pelletVer: 0,
        mode: "scatter",
        modeTimer: SCATTER_TIME,
        frenzy: 0,
        frenzyWarn: 0,
        blackout: 0,
        blackoutWarn: 0,
        effectBy: -1,
        fruit: false,
        raiderCount: 0
      });
      this.inMaze.push([]);
      this.fillBoard(this.mazes[i], false);
    }
    const homes = this.rng.shuffle([...Array(PLAYERS).keys()]);
    const names = this.rng.shuffle([...BOT_NAMES]);
    const humans = opts.humans ?? (opts.human ? [opts.humanName ?? "YOU"] : []);
    const taken = new Set(humans.map((n) => n.toUpperCase()));
    const botNames = names.filter((n) => !taken.has(n));
    for (let i = 0; i < PLAYERS; i++) {
      const human = i < humans.length;
      const home = homes[i];
      const p = {
        id: i,
        name: human ? humans[i] : botNames[(i - humans.length) % botNames.length],
        color: PLAYER_COLORS[i % PLAYER_COLORS.length],
        human,
        home,
        maze: home,
        x: 0,
        y: 0,
        dir: LEFT,
        next: LEFT,
        face: LEFT,
        lives: LIVES,
        state: "alive",
        timer: 0,
        invuln: 0,
        phase: 0,
        phaseCd: 0,
        lastPhased: -1,
        daze: 0,
        dazeCharge: 0,
        charge: 0,
        slot: null,
        placement: 0,
        stats: { dots: 0, ghosts: 0, raidersSent: 0, fruits: 0, powerUps: 0, outAt: 0 },
        bot: human ? null : makeBrain(this.rng),
        netFrames: null
      };
      if (human && !opts.humans) this.humanId = i;
      this.mazes[home].owner = i;
      this.placeAtSpawn(p);
      p.invuln = 1.5;
      this.players.push(p);
    }
    for (const m of this.mazes) {
      for (let k = 0; k < 4; k++) {
        const g = { id: this.nextId++, maze: m.idx, kind: k, x: 0, y: 0, dir: LEFT, next: -1, state: "house", timer: 0, eatenGen: -1, emerge: 0 };
        this.ghosts.push(g);
      }
      this.resetGhosts(m.idx, false);
    }
  }
  // ---------- helpers ----------
  emit(kind, e = {}, notable = false) {
    const ev = { kind, time: this.time, ...e };
    this.events.push(ev);
    if (notable) {
      this.feed.push(ev);
      if (this.feed.length > 40) this.feed.shift();
    }
  }
  /** Rebuilds the per-maze player lists (the client mirror calls this; step() does it itself). */
  rebuildInMaze() {
    for (const list of this.inMaze) list.length = 0;
    for (const p of this.players) {
      if (p.state === "out") continue;
      p.maze = this.mazeAt(p.x, p.y);
      if (p.state === "alive") this.inMaze[p.maze].push(p);
    }
  }
  /** Online: hands a player to a CPU brain (disconnect) or back to its client (reconnect). */
  setBotControl(p, on) {
    if (on) {
      p.bot = p.bot ?? makeBrain(this.rng);
      p.netFrames = null;
    } else {
      p.bot = null;
      p.netFrames = [];
    }
  }
  mazeAt(tx, ty) {
    const x = wrapX(Math.round(tx)), y = wrapY(Math.round(ty));
    return Math.floor(x / MW) + Math.floor(y / MH) * GRID;
  }
  tileIndex(tx, ty) {
    const x = wrapX(Math.round(tx)), y = wrapY(Math.round(ty));
    const m = this.mazes[Math.floor(x / MW) + Math.floor(y / MH) * GRID];
    const lx = x % MW, ly = y % MH;
    return { m, i: ly * MW + lx, lx, ly };
  }
  tileCode(tx, ty) {
    const { m, i } = this.tileIndex(tx, ty);
    return m.collapsed ? T_WALL : m.layout.tiles[i];
  }
  pacCanEnter = (tx, ty) => isWalkableCode(this.tileCode(tx, ty));
  pacSpeed(level) {
    return PAC_SPEED_BASE + PAC_SPEED_PER_LEVEL * (level - 1);
  }
  alivePlayers() {
    return this.players.filter((p) => p.state !== "out");
  }
  isFrightened(g) {
    const m = this.mazes[g.maze];
    return g.state === "active" && m.frightTimer > 0 && g.eatenGen !== m.frightGen;
  }
  raiderHarmful(r) {
    return !r.dead && r.materialize <= 0 && r.grace <= 0 && this.mazes[r.maze].frightTimer <= 0;
  }
  /** Next open maze in each of the 4 directions (wrapping, skipping collapsed ones), deduped, never `from`. */
  neighborTargets(from) {
    const m = this.mazes[from];
    const out = [];
    for (let d = 0; d < 4; d++) {
      for (let k = 1; k < GRID; k++) {
        const nx = (m.mx + DX[d] * k + GRID * 4) % GRID;
        const ny = (m.my + DY[d] * k + GRID * 4) % GRID;
        const idx = nx + ny * GRID;
        if (idx === from) break;
        if (!this.mazes[idx].collapsed) {
          if (!out.includes(idx)) out.push(idx);
          break;
        }
      }
    }
    return out;
  }
  placeAtSpawn(p) {
    const m = this.mazes[p.home];
    p.x = m.ox + SPAWN.x;
    p.y = m.oy + SPAWN.y;
    p.dir = LEFT;
    p.next = LEFT;
    p.face = LEFT;
    p.maze = p.home;
  }
  houseSlot(g) {
    const m = this.mazes[g.maze];
    g.x = m.ox + 17.4 + g.kind % 4 * 1.4;
    g.y = m.oy + HOUSE_CENTER.y;
  }
  resetGhosts(maze, quick) {
    for (const g of this.ghosts) {
      if (g.maze !== maze || g.state === "gone") continue;
      g.state = "house";
      g.timer = GHOST_RELEASE[g.kind] + (quick ? RESPAWN_RELEASE_DELAY : 0);
      g.eatenGen = this.mazes[maze].frightGen;
      this.houseSlot(g);
    }
  }
  /**
   * Turns every roaming ghost in a maze around on the spot (power pellet, mode switch).
   * The queued turn has to flip too, or the movement code reads it as a request to
   * reverse back and the turnaround is undone on the next frame.
   */
  reverseGhosts(maze) {
    for (const g of this.ghosts) {
      if (g.maze !== maze || g.state !== "active" || g.dir < 0) continue;
      g.dir = opposite(g.dir);
      g.next = g.dir;
    }
  }
  /**
   * Lays out a fresh set of pellets for a maze (match start, and after each fruit).
   * Usually one random quadrant is left bare; after a board with all four quadrants,
   * there's a chance of a completely empty board whose fruit shows up almost at once.
   */
  fillBoard(m, afterFull) {
    let board;
    if (afterFull && this.rng.chance(EMPTY_BOARD_AFTER_FULL)) board = "empty";
    else board = this.rng.chance(EMPTY_QUADRANT_CHANCE) ? "quadrant" : "full";
    m.board = board;
    m.emptyQuadrant = board === "quadrant" ? this.rng.int(4) : -1;
    m.pellets.set(m.layout.pellets);
    let dots = 0;
    for (let i = 0; i < m.pellets.length; i++) {
      if (m.pellets[i] === 0) continue;
      const lx = i % MW, ly = Math.floor(i / MW);
      const quad = (lx < MW / 2 ? 0 : 1) + (ly < MH / 2 ? 0 : 2);
      const bare = board === "empty" || board === "quadrant" && quad === m.emptyQuadrant;
      if (bare && m.pellets[i] === P_DOT) m.pellets[i] = 0;
      if (m.pellets[i] === P_DOT) dots++;
    }
    m.dotsLeft = dots;
    m.pelletVer++;
    m.fruit = false;
    m.fruitTimer = board === "empty" ? EMPTY_BOARD_FRUIT_DELAY : 0;
    this.emit("board", { maze: m.idx, text: board, n: m.emptyQuadrant });
  }
  /** Moves a ghost in a straight line toward (tx, ty) in local maze coords. Returns the distance left over. */
  glide(g, tx, ty, dist3) {
    const m = this.mazes[g.maze];
    const dx = m.ox + tx - g.x, dy = m.oy + ty - g.y;
    const d = Math.abs(dx) + Math.abs(dy);
    if (d <= dist3) {
      g.x = m.ox + tx;
      g.y = m.oy + ty;
      return dist3 - d;
    }
    if (Math.abs(dx) > 1e-6) g.x += Math.sign(dx) * Math.min(dist3, Math.abs(dx));
    else g.y += Math.sign(dy) * dist3;
    return 0;
  }
  /** Ghost crawling out of the house: to the middle, up through the gate, then a half step onto the exit tile. */
  updateLeaving(g, dt) {
    const m = this.mazes[g.maze];
    const exitX = g.kind % 2 === 0 ? HOUSE_EXIT.x : HOUSE_EXIT.x + 1;
    let dist3 = this.pacSpeed(m.level) * GHOST_LEAVE_FACTOR * dt;
    const lx = g.x - m.ox, ly = g.y - m.oy;
    if (ly > HOUSE_EXIT.y + 1e-6) {
      if (Math.abs(lx - HOUSE_CENTER.x) > 1e-6) dist3 = this.glide(g, HOUSE_CENTER.x, ly, dist3);
      if (dist3 > 0) dist3 = this.glide(g, HOUSE_CENTER.x, HOUSE_EXIT.y, dist3);
    }
    if (dist3 <= 0) return;
    const ex = m.ox + exitX, ey = m.oy + HOUSE_EXIT.y;
    if (this.inMaze[g.maze].some((p) => dist2(p.x, p.y, ex, ey) < 1.5 * 1.5)) return;
    dist3 = this.glide(g, exitX, HOUSE_EXIT.y, dist3);
    if (Math.abs(g.x - ex) < 1e-6) {
      g.state = "active";
      g.dir = g.kind % 2 === 0 ? LEFT : RIGHT;
      g.next = -1;
      g.emerge = GHOST_EMERGE_TIME;
    }
  }
  /** Eaten ghost's eyes sinking back into the house. */
  updateEntering(g, dt) {
    const m = this.mazes[g.maze];
    let dist3 = this.pacSpeed(m.level) * GHOST_EYES_FACTOR * 0.5 * dt;
    if (g.y - m.oy < HOUSE_CENTER.y - 1e-6) {
      dist3 = this.glide(g, HOUSE_CENTER.x, g.y - m.oy, dist3);
      if (dist3 > 0) dist3 = this.glide(g, HOUSE_CENTER.x, HOUSE_CENTER.y, dist3);
    }
    if (dist3 <= 0) return;
    const slotX = 17.4 + g.kind % 4 * 1.4;
    dist3 = this.glide(g, slotX, HOUSE_CENTER.y, dist3);
    if (Math.abs(g.x - (m.ox + slotX)) < 1e-6) {
      g.state = "house";
      g.timer = EATEN_REENTER;
    }
  }
  // ---------- player actions ----------
  setDir(p, d) {
    if (p.state !== "alive") return;
    p.next = d;
  }
  usePower(p) {
    if (p.state !== "alive" || !p.slot || p.dazeCharge > 0) return;
    const kind = p.slot;
    p.slot = null;
    p.stats.powerUps++;
    if (kind === "daze") {
      p.dazeCharge = DAZE_CHARGE;
      this.emit("dazeCharge", { player: p.id, maze: p.maze, color: p.color, text: `${p.name} is charging DAZE` }, true);
      return;
    }
    const targets = this.neighborTargets(p.maze);
    for (const t of targets) {
      const m = this.mazes[t];
      if (kind === "blackout") m.blackoutWarn = POWERUP_WARN;
      else m.frenzyWarn = POWERUP_WARN;
      m.effectBy = p.id;
    }
    const label = kind === "blackout" ? "BLACKOUT" : "FRENZY";
    this.emit(kind, { player: p.id, maze: p.maze, target: targets, color: p.color, text: `${p.name} cast ${label} on ${targets.map(mazeName).join(" ")}` }, true);
  }
  // ---------- simulation ----------
  step(dt) {
    if (this.over) return;
    if (this.countdown > 0) {
      const before = Math.ceil(this.countdown);
      this.countdown = Math.max(0, this.countdown - dt);
      const after = Math.ceil(this.countdown);
      if (after !== before) this.emit("count", { n: after });
      return;
    }
    this.time += dt;
    for (const list of this.inMaze) list.length = 0;
    for (const p of this.players) {
      if (p.state === "out") continue;
      p.maze = this.mazeAt(p.x, p.y);
      if (p.state === "alive") this.inMaze[p.maze].push(p);
    }
    this.updateMazes(dt);
    this.updatePlayers(dt);
    this.updateGhosts(dt);
    this.updateRaiders(dt);
    this.collide();
    this.updateWorld(dt);
    this.checkWin();
  }
  updateMazes(dt) {
    for (const m of this.mazes) {
      if (m.collapsed) continue;
      if (m.hitstop > 0) {
        m.hitstop = Math.max(0, m.hitstop - dt);
        continue;
      }
      if (m.fruitTimer > 0) {
        m.fruitTimer -= dt;
        if (m.fruitTimer <= 0 && !m.fruit && m.dotsLeft <= 0) {
          m.fruitTimer = 0;
          m.fruit = true;
          this.emit("fruitSpawn", { maze: m.idx, x: m.ox + FRUIT.x, y: m.oy + FRUIT.y, text: `Empty board in ${mazeName(m.idx)} \u2014 fruit appeared` }, true);
        }
      }
      if (m.collapseTimer > 0) {
        const before = Math.ceil(m.collapseTimer);
        m.collapseTimer -= dt;
        const after = Math.ceil(m.collapseTimer);
        if (after !== before && after > 0) this.emit("collapseTick", { maze: m.idx, n: after });
        if (m.collapseTimer <= 0) this.collapse(m);
        if (m.collapsed) continue;
      }
      if (m.frightTimer > 0) {
        m.frightTimer -= dt;
        if (m.frightTimer <= 0) {
          m.frightTimer = 0;
          for (const r of this.raiders) if (r.maze === m.idx && !r.dead) r.grace = RAIDER_THAW_GRACE;
        }
      } else {
        m.modeTimer -= dt;
        if (m.modeTimer <= 0) {
          m.mode = m.mode === "scatter" ? "chase" : "scatter";
          m.modeTimer = m.mode === "scatter" ? SCATTER_TIME : CHASE_TIME;
          this.reverseGhosts(m.idx);
        }
      }
      if (m.blackoutWarn > 0) {
        m.blackoutWarn -= dt;
        if (m.blackoutWarn <= 0) {
          m.blackoutWarn = 0;
          m.blackout = BLACKOUT_TIME;
        }
      } else if (m.blackout > 0) m.blackout = Math.max(0, m.blackout - dt);
      if (m.frenzyWarn > 0) {
        m.frenzyWarn -= dt;
        if (m.frenzyWarn <= 0) {
          m.frenzyWarn = 0;
          m.frenzy = FRENZY_TIME;
        }
      } else if (m.frenzy > 0) m.frenzy = Math.max(0, m.frenzy - dt);
    }
  }
  updatePlayers(dt) {
    for (const p of this.players) {
      if (p.state === "out") continue;
      if (p.state === "dying") {
        p.timer -= dt;
        if (p.timer <= 0) this.afterDeath(p);
        if (p.netFrames) p.netFrames = [];
        continue;
      }
      if (this.mazes[p.maze].hitstop > 0) {
        if (p.netFrames) p.netFrames = [];
        continue;
      }
      if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);
      if (p.phase > 0) {
        p.phase = Math.max(0, p.phase - dt);
        if (p.phase === 0) p.lastPhased = -1;
      }
      if (p.phaseCd > 0) p.phaseCd = Math.max(0, p.phaseCd - dt);
      if (p.dazeCharge > 0) {
        p.dazeCharge -= dt;
        if (p.dazeCharge <= 0) this.fireDaze(p);
      }
      if (p.bot) botUpdate(this, p, dt);
      const frames = p.netFrames;
      if (frames) p.netFrames = [];
      if (p.daze > 0) {
        p.daze = Math.max(0, p.daze - dt);
        continue;
      }
      if (frames) {
        for (const f of frames) {
          if (f === NET_HOLD) continue;
          if (f >= 0) p.next = f;
          this.movePlayer(p, dt);
          if (p.state !== "alive") break;
        }
      } else {
        this.movePlayer(p, dt);
      }
    }
  }
  movePlayer(p, dt) {
    const level = this.mazes[p.maze].level;
    const ox = p.x, oy = p.y, oMaze = p.maze;
    move(p, this.pacSpeed(level) * dt, {
      canEnter: this.pacCanEnter,
      tunnel: true,
      atCenter: p.bot ? () => botDecide(this, p) : void 0,
      cornerCut: CORNER_CUT,
      onCorner: (cut, fx, fy, fdir) => this.onCorner(p, cut, fx, fy, fdir)
    });
    if (p.dir >= 0) p.face = p.dir;
    p.maze = this.mazeAt(p.x, p.y);
    if (Math.abs(wrapDelta(p.x - ox, WORLD_W)) > 2) {
      this.emit("warp", { player: p.id, maze: p.maze, x: Math.round(ox), y: Math.round(oy), x2: p.x, y2: p.y });
    } else if (p.maze !== oMaze) {
      this.emit("door", { player: p.id, maze: p.maze, n: oMaze, x: p.x, y: p.y });
    }
    this.eatAt(p);
    if (p.slot === null && p.charge >= CHARGE_FULL) {
      p.slot = this.rng.weighted(["blackout", "frenzy", "daze"], [40, 40, 20]);
      p.charge = 0;
      this.emit("pickup", { player: p.id, text: p.slot, color: p.color });
    }
  }
  eatAt(p) {
    const { m, i } = this.tileIndex(p.x, p.y);
    if (m.collapsed) return;
    const pel = m.pellets[i];
    if (pel === P_DOT) {
      m.pellets[i] = 0;
      m.dotsLeft--;
      p.stats.dots++;
      p.charge = Math.min(CHARGE_FULL, p.charge + (m.idx === p.home ? CHARGE_HOME : CHARGE_AWAY));
      this.emit("dot", { player: p.id, maze: m.idx, x: Math.round(p.x), y: Math.round(p.y) });
      if (m.dotsLeft <= 0 && !m.fruit) {
        m.fruit = true;
        this.emit("fruitSpawn", { maze: m.idx, x: m.ox + FRUIT.x, y: m.oy + FRUIT.y, text: `${mazeName(m.idx)} cleared \u2014 fruit appeared` }, true);
      }
    } else if (pel === P_POWER) {
      m.pellets[i] = 0;
      m.frightTimer = FRIGHT_TIME[m.level];
      m.frightGen++;
      m.combo = 0;
      this.reverseGhosts(m.idx);
      this.emit("power", { player: p.id, maze: m.idx, x: Math.round(p.x), y: Math.round(p.y) });
    }
    if (m.fruit && dist2(p.x, p.y, m.ox + FRUIT.x, m.oy + FRUIT.y) < 0.8 * 0.8) this.eatFruit(p, m);
    for (let k = this.airdrops.length - 1; k >= 0; k--) {
      const a = this.airdrops[k];
      if (p.slot === null && a.maze === m.idx && dist2(p.x, p.y, a.x, a.y) < 0.8 * 0.8) {
        p.slot = this.rng.pick(["blackout", "frenzy", "daze"]);
        this.airdrops.splice(k, 1);
        this.emit("pickup", { player: p.id, text: p.slot, color: p.color, maze: m.idx, x: a.x, y: a.y });
      }
    }
  }
  eatFruit(p, m) {
    m.fruit = false;
    this.fillBoard(m, m.board === "full");
    const before = m.level;
    m.level = Math.min(MAX_LEVEL, m.level + 1);
    if (m.level !== before) this.emit("levelUp", { maze: m.idx, n: m.level });
    p.stats.fruits++;
    for (const r of this.raiders) if (r.maze === m.idx) r.dead = true;
    let text = `${p.name} ate the fruit in ${mazeName(m.idx)} \u2014 Lv ${m.level}`;
    if (m.owner !== p.id && m.owner >= 0 && this.players[m.owner].state !== "out") {
      const home = this.mazes[p.home];
      if (!home.collapsed) {
        for (const i of home.layout.powerTiles) home.pellets[i] = P_POWER;
        home.pelletVer++;
        text = `${p.name} raided ${this.players[m.owner].name}'s fruit \u2014 power pellets reloaded`;
        this.emit("reload", { player: p.id, maze: home.idx });
      }
    }
    this.emit("fruit", { player: p.id, maze: m.idx, x: m.ox + FRUIT.x, y: m.oy + FRUIT.y, text, color: p.color }, true);
  }
  fireDaze(p) {
    p.dazeCharge = 0;
    if (p.state !== "alive") return;
    const victims = [];
    for (const q of this.inMaze[p.maze]) {
      if (q === p || q.invuln > 0 || q.state !== "alive") continue;
      q.daze = DAZE_TIME;
      victims.push(q.name);
    }
    this.emit("daze", { player: p.id, maze: p.maze, color: p.color, text: victims.length ? `${p.name} dazed ${victims.join(", ")}` : `${p.name}'s DAZE hit nobody` }, true);
  }
  /** Ghost chase speed relative to a Pac-Man in the same maze (ignores fright and tunnels). */
  ghostChaseRatio(g) {
    const m = this.mazes[g.maze];
    let r = GHOST_SPEED_FACTOR[m.level];
    if (m.frenzy > 0) r *= FRENZY_FACTOR;
    if (g.kind === 0 && m.dotsLeft <= ELROY_PELLETS[m.level]) r *= ELROY_FACTOR;
    return r;
  }
  ghostSpeed(g) {
    const m = this.mazes[g.maze];
    const base = this.pacSpeed(m.level);
    if (g.state === "eyes") return base * GHOST_EYES_FACTOR;
    let s = base * GHOST_SPEED_FACTOR[m.level];
    if (this.isFrightened(g)) s = base * GHOST_FRIGHT_FACTOR;
    else {
      if (m.frenzy > 0) s *= FRENZY_FACTOR;
      if (g.kind === 0 && m.dotsLeft <= ELROY_PELLETS[m.level]) s *= ELROY_FACTOR;
    }
    if (g.emerge > 0) {
      const t = 1 - g.emerge / GHOST_EMERGE_TIME;
      s *= GHOST_EMERGE_FACTOR + (1 - GHOST_EMERGE_FACTOR) * t;
    }
    const ly = Math.round(g.y) - m.oy, lx = Math.round(g.x) - m.ox;
    if (ly === TUNNEL_ROW && (lx <= 2 || lx >= MW - 3)) s *= GHOST_TUNNEL_FACTOR;
    return s;
  }
  updateGhosts(dt) {
    for (const g of this.ghosts) {
      if (g.state === "gone") continue;
      const m = this.mazes[g.maze];
      if (m.hitstop > 0) continue;
      if (g.state === "house") {
        g.timer -= dt;
        if (g.timer <= 0) g.state = "leaving";
        continue;
      }
      if (g.state === "leaving") {
        this.updateLeaving(g, dt);
        continue;
      }
      if (g.state === "entering") {
        this.updateEntering(g, dt);
        continue;
      }
      if (g.emerge > 0) g.emerge = Math.max(0, g.emerge - dt);
      if (g.state === "eyes") {
        g.timer += dt;
        if (g.timer > 12) {
          g.x = m.ox + HOUSE_EXIT.x;
          g.y = m.oy + HOUSE_EXIT.y;
          g.state = "entering";
          g.dir = -1;
          g.next = -1;
          continue;
        }
      }
      const canEnter = (tx, ty) => this.mazeAt(tx, ty) === g.maze && isWalkableCode(this.tileCode(tx, ty));
      move(g, this.ghostSpeed(g) * dt, {
        canEnter,
        tunnel: true,
        atCenter: () => {
          if (g.state === "eyes" && Math.round(g.x) === m.ox + HOUSE_EXIT.x && Math.round(g.y) === m.oy + HOUSE_EXIT.y) {
            g.state = "entering";
            g.dir = -1;
            g.next = -1;
            return;
          }
          chooseGhostDir(this, g, canEnter);
        }
      });
    }
  }
  updateRaiders(dt) {
    for (const r of this.raiders) {
      if (r.dead) continue;
      const m = this.mazes[r.maze];
      if (m.hitstop > 0) continue;
      r.life -= dt;
      if (r.life <= 0 || m.collapsed) {
        r.dead = true;
        continue;
      }
      if (r.materialize > 0) {
        r.materialize -= dt;
        continue;
      }
      if (m.frightTimer > 0) continue;
      if (r.grace > 0) r.grace -= dt;
      const canEnter = (tx, ty) => {
        if (this.mazeAt(tx, ty) !== r.maze) return false;
        const { lx, ly } = this.tileIndex(tx, ty);
        if (lx === 0 || ly === 0 || lx === MW - 1 || ly === MH - 1) return false;
        return this.tileCode(tx, ty) === T_OPEN;
      };
      move(r, PAC_SPEED_BASE * RAIDER_SPEED_FACTOR * dt, { canEnter, atCenter: () => chooseRaiderDir(this, r, canEnter) });
    }
    if (this.raiders.length > 64) this.raiders = this.raiders.filter((r) => !r.dead);
    for (const m of this.mazes) m.raiderCount = 0;
    for (const r of this.raiders) if (!r.dead) this.mazes[r.maze].raiderCount++;
  }
  collide() {
    const R2 = COLLIDE_DIST * COLLIDE_DIST;
    for (const p of this.players) {
      if (p.state !== "alive" || this.mazes[p.maze].hitstop > 0) continue;
      for (const g of this.ghosts) {
        if (g.maze !== p.maze || g.state !== "active") continue;
        if (dist2(p.x, p.y, g.x, g.y) > R2) continue;
        if (this.isFrightened(g)) this.eatGhost(p, g);
        else if (p.phase > 0) this.phaseThrough(p, g.id, g.x, g.y, "ghost", g.kind);
        else if (p.invuln <= 0) {
          this.kill(p, "ghost");
          break;
        }
      }
      if (p.state !== "alive" || p.invuln > 0) continue;
      for (const r of this.raiders) {
        if (r.maze !== p.maze || !this.raiderHarmful(r)) continue;
        if (dist2(p.x, p.y, r.x, r.y) <= R2) {
          if (p.phase > 0) {
            this.phaseThrough(p, r.id, r.x, r.y, "raider", r.sender);
            continue;
          }
          this.kill(p, "raider", r.sender);
          break;
        }
      }
    }
  }
  /** A turn queued before the corner was taken early: sparks, and maybe a pass-through window. */
  onCorner(p, cut, fx, fy, fdir) {
    const granted = p.phaseCd <= 0;
    if (granted) {
      p.phase = PHASE_TIME;
      p.phaseCd = PHASE_COOLDOWN;
    }
    this.emit("corner", { player: p.id, maze: p.maze, x: p.x, y: p.y, x2: fx, y2: fy, n: fdir, text: granted ? "phase" : "", color: p.color });
    void cut;
  }
  /** Passing through an enemy during a cornering window: no death, a freeze-frame and a big effect. */
  phaseThrough(p, id, x, y, what, ref) {
    if (p.lastPhased === id) return;
    p.lastPhased = id;
    p.phase = Math.max(p.phase, 0.15);
    const m = this.mazes[p.maze];
    m.hitstop = Math.max(m.hitstop, PHASE_HITSTOP);
    const color = what === "raider" ? this.players[ref].color : ["#FF2E3E", "#FFA6E6", "#2EE6FF", "#FFAA3D"][ref % 4];
    this.emit("phase", { player: p.id, maze: p.maze, x, y, x2: p.x, y2: p.y, color, text: what });
  }
  eatGhost(p, g) {
    const m = this.mazes[g.maze];
    g.state = "eyes";
    g.timer = 0;
    g.eatenGen = m.frightGen;
    p.stats.ghosts++;
    m.combo++;
    m.hitstop = HITSTOP;
    let targets = [];
    if (p.maze !== p.home) targets = this.sendRaiders(p.maze, p);
    this.emit("ghost", { player: p.id, maze: m.idx, x: g.x, y: g.y, color: p.color, target: targets, n: m.combo });
    if (targets.length) {
      this.emit("raiders", { player: p.id, color: p.color, target: targets, text: `${p.name} sent raiders to ${targets.map(mazeName).join(" ")}` }, true);
    }
  }
  sendRaiders(from, sender) {
    const hit = [];
    for (const t of this.neighborTargets(from)) {
      if (this.inMaze[t].length === 0) continue;
      if (this.spawnRaider(t, sender)) hit.push(t);
    }
    return hit;
  }
  /** Multi-source BFS inside one maze; fills bfsDist for tiles of that maze. Returns the generation stamp. */
  bfsInMaze(maze, sources, walk) {
    const gen2 = ++this.bfsGen;
    const q = [];
    for (const s of sources) {
      const x = wrapX(Math.round(s.x)), y = wrapY(Math.round(s.y));
      const k = y * WORLD_W + x;
      if (this.bfsStamp[k] === gen2) continue;
      this.bfsStamp[k] = gen2;
      this.bfsDist[k] = 0;
      q.push(k);
    }
    for (let h = 0; h < q.length; h++) {
      const k = q[h];
      const x = k % WORLD_W, y = Math.floor(k / WORLD_W);
      for (let d = 0; d < 4; d++) {
        const nx = wrapX(x + DX[d]), ny = wrapY(y + DY[d]);
        const nk = ny * WORLD_W + nx;
        if (this.bfsStamp[nk] === gen2) continue;
        if (this.mazeAt(nx, ny) !== maze || !walk(nx, ny)) continue;
        this.bfsStamp[nk] = gen2;
        this.bfsDist[nk] = this.bfsDist[k] + 1;
        q.push(nk);
      }
    }
    return gen2;
  }
  spawnRaider(maze, sender) {
    const m = this.mazes[maze];
    if (m.collapsed || m.raiderCount >= MAX_RAIDERS_PER_MAZE) return false;
    const pacs = this.inMaze[maze];
    const occupied = /* @__PURE__ */ new Set();
    for (const q of pacs) {
      const lx = Math.round(q.x) - m.ox, ly = Math.round(q.y) - m.oy;
      occupied.add((lx < MW / 2 ? 0 : 1) + (ly < MH / 2 ? 0 : 2));
    }
    const gen2 = this.bfsInMaze(maze, pacs, this.pacCanEnter);
    const good = [];
    let far = -1, farD = -1;
    for (const i2 of m.layout.dotTiles) {
      const lx = i2 % MW, ly = Math.floor(i2 / MW);
      const k = (m.oy + ly) * WORLD_W + (m.ox + lx);
      const d = this.bfsStamp[k] === gen2 ? this.bfsDist[k] : 999;
      if (d > farD) {
        farD = d;
        far = i2;
      }
      const quad = (lx < MW / 2 ? 0 : 1) + (ly < MH / 2 ? 0 : 2);
      if (!occupied.has(quad) && d >= RAIDER_MIN_PATH) good.push(i2);
    }
    const i = good.length ? this.rng.pick(good) : far;
    if (i < 0) return false;
    const r = {
      id: this.nextId++,
      maze,
      sender: sender.id,
      x: m.ox + i % MW,
      y: m.oy + Math.floor(i / MW),
      dir: -1,
      next: -1,
      life: RAIDER_LIFE,
      materialize: RAIDER_MATERIALIZE,
      grace: 0,
      dead: false
    };
    this.raiders.push(r);
    m.raiderCount++;
    sender.stats.raidersSent++;
    return true;
  }
  kill(p, cause, by = -1) {
    if (p.state !== "alive") return;
    p.state = "dying";
    p.timer = DEATH_TIME;
    p.lives--;
    p.daze = 0;
    p.dazeCharge = 0;
    const byText = cause === "raider" && by >= 0 ? ` by ${this.players[by].name}'s raider` : cause === "collapse" ? " in a collapse" : "";
    this.emit("death", { player: p.id, maze: p.maze, x: p.x, y: p.y, color: p.color, text: `${p.name} lost a life${byText}` }, p.human || cause !== "ghost");
  }
  afterDeath(p) {
    if (p.lives > 0) {
      p.state = "alive";
      this.placeAtSpawn(p);
      p.invuln = RESPAWN_INVULN;
      for (const r of this.raiders) if (r.maze === p.home) r.dead = true;
      this.resetGhosts(p.home, true);
      this.emit("respawn", { player: p.id, maze: p.home });
      return;
    }
    p.state = "out";
    p.stats.outAt = this.time;
    p.placement = this.players.filter((q) => q.state !== "out").length + 1;
    const home = this.mazes[p.home];
    if (!home.collapsed && home.collapseTimer <= 0) home.collapseTimer = COLLAPSE_COUNTDOWN;
    this.emit("out", { player: p.id, maze: p.home, color: p.color, text: `${p.name} eliminated (#${p.placement}) \u2014 ${mazeName(p.home)} collapsing` }, true);
    this.emit("collapseStart", { maze: p.home });
  }
  collapse(m) {
    m.collapsed = true;
    m.collapseTimer = 0;
    m.fruit = false;
    m.fruitTimer = 0;
    m.pellets.fill(0);
    m.pelletVer++;
    m.dotsLeft = 0;
    m.frightTimer = 0;
    m.blackout = m.blackoutWarn = m.frenzy = m.frenzyWarn = 0;
    for (const g of this.ghosts) if (g.maze === m.idx) g.state = "gone";
    for (const r of this.raiders) if (r.maze === m.idx) r.dead = true;
    this.airdrops = this.airdrops.filter((a) => a.maze !== m.idx);
    for (const p of this.players) {
      if (p.state === "alive" && this.mazeAt(p.x, p.y) === m.idx) this.kill(p, "collapse");
    }
    this.emit("collapse", { maze: m.idx, text: `${mazeName(m.idx)} collapsed` }, true);
  }
  updateWorld(dt) {
    this.airdropTimer -= dt;
    if (this.airdropTimer <= 0) {
      this.airdropTimer = AIRDROP_EVERY;
      if (this.airdrops.length < MAX_AIRDROPS) {
        const open = this.mazes.filter((m) => !m.collapsed);
        if (open.length) {
          const m = this.rng.pick(open);
          const i = this.rng.pick(m.layout.dotTiles);
          const a = { id: this.nextId++, maze: m.idx, x: m.ox + i % MW, y: m.oy + Math.floor(i / MW) };
          this.airdrops.push(a);
          this.emit("airdrop", { maze: m.idx, x: a.x, y: a.y, text: `Airdrop landed in ${mazeName(m.idx)}` }, true);
        }
      }
    }
    if (this.time >= OVERTIME_START) {
      this.overtimeTimer -= dt;
      if (this.overtimeTimer <= 0) {
        this.overtimeTimer = OVERTIME_EVERY;
        let added = false;
        for (const m of this.mazes) {
          if (m.collapsed) continue;
          if (m.level < MAX_LEVEL) {
            m.level++;
            this.emit("levelUp", { maze: m.idx, n: m.level });
            continue;
          }
          const count = this.ghosts.filter((g2) => g2.maze === m.idx && g2.state !== "gone").length;
          if (count >= MAX_GHOSTS_PER_MAZE) continue;
          const g = { id: this.nextId++, maze: m.idx, kind: count % 4, x: 0, y: 0, dir: LEFT, next: -1, state: "house", timer: 1, eatenGen: m.frightGen, emerge: 0 };
          this.houseSlot(g);
          this.ghosts.push(g);
          added = true;
        }
        this.emit("overtime", { text: added ? "Overtime \u2014 an extra ghost joined every maze" : "Overtime \u2014 every maze leveled up" }, true);
      }
    }
  }
  checkWin() {
    const alive = this.players.filter((p) => p.state !== "out");
    if (alive.length > 1) return;
    this.over = true;
    let w = alive[0];
    if (!w) {
      const last2 = this.players.filter((p) => p.placement === 2 || p.placement === 1);
      w = last2.sort((a, b) => b.stats.dots - a.stats.dots)[0] ?? this.players[0];
    }
    w.placement = 1;
    this.winner = w.id;
    this.emit("win", { player: w.id, color: w.color, text: `${w.name} wins!` }, true);
  }
};

// src/net/protocol.ts
var PROTOCOL = 1;
var SNAPSHOT_EVERY = 2;
var MAX_HUMANS = PLAYERS;
var FROZEN = 8;
var LOBBY_SECONDS = 20;
var PSTATE = ["alive", "dying", "out"];
var GSTATE = ["house", "leaving", "active", "eyes", "entering", "gone"];
var SLOTS = ["blackout", "frenzy", "daze"];
var BOARDS = ["full", "quadrant", "empty"];
var r3 = (v) => Math.round(v * 1e3) / 1e3;
var r2 = (v) => Math.round(v * 100) / 100;
function neighborhood(maze) {
  const mx = maze % GRID, my = Math.floor(maze / GRID);
  const out = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    out.push((mx + dx + GRID) % GRID + (my + dy + GRID) % GRID * GRID);
  }
  return out;
}
function mazeRow(m) {
  return [
    m.idx,
    m.level,
    m.collapsed ? 1 : 0,
    r2(m.collapseTimer),
    r2(m.frightTimer),
    m.frightGen,
    r2(m.frenzy),
    r2(m.frenzyWarn),
    r2(m.blackout),
    r2(m.blackoutWarn),
    m.effectBy,
    m.fruit ? 1 : 0,
    r2(m.fruitTimer),
    r3(m.hitstop),
    m.dotsLeft,
    m.owner,
    m.combo,
    m.mode === "chase" ? 1 : 0,
    m.raiderCount,
    BOARDS.indexOf(m.board),
    m.emptyQuadrant
  ];
}
function playerRow(game, id) {
  const p = game.players[id];
  return [
    p.id,
    r3(p.x),
    r3(p.y),
    p.dir,
    p.next,
    p.face,
    PSTATE.indexOf(p.state),
    p.lives,
    r2(p.invuln),
    r3(p.phase),
    r2(p.phaseCd),
    r2(p.daze),
    r2(p.dazeCharge),
    Math.round(p.charge),
    p.slot ? SLOTS.indexOf(p.slot) : -1,
    r2(p.timer),
    p.placement
  ];
}
function farRow(game, id) {
  const p = game.players[id];
  return [p.id, r2(p.x), r2(p.y), PSTATE.indexOf(p.state), p.lives];
}
function ghostRows(game, mazes) {
  const out = [];
  for (const g of game.ghosts) {
    if (!mazes.has(g.maze) || g.state === "gone") continue;
    out.push([g.id, g.maze, g.kind, r3(g.x), r3(g.y), g.dir, GSTATE.indexOf(g.state), g.eatenGen, r2(g.emerge), r2(g.timer)]);
  }
  return out;
}
function raiderRows(game, mazes) {
  const out = [];
  for (const r of game.raiders) {
    if (r.dead || !mazes.has(r.maze)) continue;
    out.push([r.id, r.maze, r.sender, r3(r.x), r3(r.y), r.dir, r2(r.life), r2(r.materialize), r2(r.grace)]);
  }
  return out;
}
function encodePellets(p) {
  let s = "";
  for (let i = 0; i < p.length; i++) s += String.fromCharCode(p[i]);
  return btoa(s);
}

// server/main.ts
var PORT = Number(process.env.PORT ?? 8080);
var CLIENT = path.resolve(process.env.CLIENT_FILE ?? path.join(process.cwd(), "dist", "index.html"));
var RECONNECT_WINDOW = 6e4;
var ROOM_LINGER = 3e4;
var MAX_ROOMS = Number(process.env.MAX_ROOMS ?? 16);
var MAX_DEBT = Number(process.env.MAX_DEBT ?? 0);
var PRIME = Number(process.env.PRIME ?? 2);
var SPEED = Number(process.env.SPEED ?? 1);
var log = (...a) => console.log((/* @__PURE__ */ new Date()).toISOString(), ...a);
var Conn = class {
  constructor(ws, ip) {
    this.ws = ws;
    this.ip = ip;
  }
  ws;
  ip;
  name = "PLAYER";
  token = crypto.randomBytes(12).toString("hex");
  room = null;
  slot = -1;
  frames = [];
  debt = 0;
  // ticks the player moved without a frame from the client
  carry = -1;
  // steering from a late frame, applied on the next move
  debtAge = 0;
  primed = false;
  ack = 0;
  power = false;
  view = -1;
  alive = true;
  // per-connection sync bookkeeping
  pelletVer = /* @__PURE__ */ new Map();
  mazeRows = [];
  airdrops = "";
  fullAt = 0;
  send(msg) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (msg.t === "snap" && this.ws.bufferedAmount > 512 * 1024) return;
    this.ws.send(JSON.stringify(msg));
  }
  resetSync() {
    this.pelletVer.clear();
    this.mazeRows = [];
    this.airdrops = "";
    this.frames = [];
    this.debt = 0;
    this.carry = -1;
    this.debtAge = 0;
    this.primed = false;
  }
};
var Room = class {
  constructor(code) {
    this.code = code;
  }
  code;
  state = "lobby";
  members = /* @__PURE__ */ new Set();
  host = null;
  startsAt = 0;
  game = null;
  seats = [];
  tick = 0;
  events = [];
  endedAt = 0;
  get isQuick() {
    return this.code === null;
  }
  lobbyInfo(c) {
    return {
      t: "lobby",
      code: this.code,
      host: this.host === c,
      names: [...this.members].map((m) => m.name),
      startsIn: this.isQuick && this.startsAt ? Math.max(0, Math.ceil((this.startsAt - Date.now()) / 1e3)) : null,
      max: MAX_HUMANS
    };
  }
  broadcastLobby() {
    for (const m of this.members) m.send(this.lobbyInfo(m));
  }
  add(c) {
    this.members.add(c);
    c.room = this;
    if (!this.host) this.host = c;
    if (this.isQuick && !this.startsAt) this.startsAt = Date.now() + LOBBY_SECONDS * 1e3;
    if (this.members.size >= MAX_HUMANS) this.start();
    else this.broadcastLobby();
  }
  remove(c) {
    c.room = null;
    if (this.state === "lobby") {
      this.members.delete(c);
      if (this.host === c) this.host = this.members.values().next().value ?? null;
      if (this.members.size === 0) closeRoom(this);
      else this.broadcastLobby();
      return;
    }
    this.members.delete(c);
    const seat = this.seats[c.slot];
    if (seat && this.game) {
      seat.conn = null;
      seat.droppedAt = Date.now();
      this.game.setBotControl(this.game.players[c.slot], true);
    }
  }
  start() {
    if (this.state !== "lobby") return;
    if (this === quickRoom) quickRoom = null;
    this.state = "playing";
    const conns = [...this.members];
    const used = /* @__PURE__ */ new Set();
    const names = conns.map((c) => {
      let n = c.name;
      for (let k = 2; used.has(n); k++) n = `${c.name.slice(0, 8)}${k}`;
      used.add(n);
      return n;
    });
    const seed = crypto.randomInt(1, 2 ** 31);
    this.game = new Game({ seed, human: false, humans: names, countdown: COUNTDOWN });
    this.seats = conns.map((c, i) => ({ conn: c, name: names[i], token: c.token, droppedAt: 0 }));
    conns.forEach((c, i) => {
      c.slot = i;
      tokens.set(c.token, { room: this, slot: i });
      c.resetSync();
      this.game.setBotControl(this.game.players[i], false);
      c.send({ t: "start", seed, humans: names, you: i, countdown: COUNTDOWN });
    });
    log(`match start room=${this.code ?? "quick"} humans=${names.length} seed=${seed}`);
  }
  rejoin(c, slot) {
    const seat = this.seats[slot];
    if (!seat || !this.game) return;
    seat.conn = c;
    seat.droppedAt = 0;
    c.room = this;
    c.slot = slot;
    c.name = seat.name;
    c.resetSync();
    this.members.add(c);
    this.game.setBotControl(this.game.players[slot], false);
    const humans = this.seats.map((s) => s.name);
    c.send({ t: "start", seed: this.game.seed, humans, you: slot, countdown: 0, rejoin: true });
    log(`rejoin room=${this.code ?? "quick"} slot=${slot}`);
  }
  step() {
    const game = this.game;
    for (const c of this.members) {
      if (c.slot < 0) continue;
      const p = game.players[c.slot];
      if (c.power) {
        c.power = false;
        game.usePower(p);
      }
      if (game.countdown > 0 || p.netFrames === null || p.state !== "alive") {
        if (c.frames.length) c.ack = c.frames[c.frames.length - 1][0];
        c.frames.length = 0;
        c.debt = 0;
        c.carry = -1;
        c.primed = false;
        continue;
      }
      if (!c.primed) {
        if (c.frames.length < PRIME) continue;
        c.primed = true;
      }
      const m = game.mazes[game.mazeAt(p.x, p.y)];
      if (Math.max(0, m.hitstop - TICK) > 0) continue;
      while (c.debt > 0 && c.frames.length) {
        const [seq, next] = c.frames.shift();
        if (next >= 0 && next <= 3) c.carry = next;
        c.ack = seq;
        c.debt--;
      }
      if (c.frames.length > 60) {
        const drop = c.frames.splice(0, c.frames.length - 4);
        c.ack = drop[drop.length - 1][0];
      }
      const take = c.frames.length > 6 ? 2 : c.frames.length > 0 ? 1 : 0;
      for (let k = 0; k < take; k++) {
        const [seq, next] = c.frames.shift();
        if (next >= FROZEN - 1) p.netFrames.push(NET_HOLD);
        else {
          p.netFrames.push(next >= 0 ? next : c.carry);
          c.carry = -1;
        }
        c.ack = seq;
      }
      c.debtAge = c.debt > 0 ? c.debtAge + 1 : 0;
      if (take === 0) {
        if (c.debt < MAX_DEBT && c.debtAge < 30) {
          p.netFrames.push(c.carry);
          c.carry = -1;
          c.debt++;
        } else if (c.debtAge >= 30) {
          c.debtAge = 0;
        } else {
          c.primed = false;
        }
      }
    }
    game.step(TICK);
    this.tick++;
    for (const e of game.events) {
      const w = e;
      if (game.feed.includes(e)) w.f = 1;
      this.events.push(w);
    }
    game.events.length = 0;
    for (const s of this.seats) {
      if (!s.conn && s.droppedAt && Date.now() - s.droppedAt > RECONNECT_WINDOW) {
        tokens.delete(s.token);
        s.droppedAt = 0;
      }
    }
    if (this.tick % SNAPSHOT_EVERY === 0) {
      for (const c of this.members) c.send(this.snapshot(c));
      this.events.length = 0;
    }
    if (game.over && this.state === "playing") {
      this.state = "over";
      this.endedAt = Date.now();
      for (const c of this.members) c.send(this.snapshot(c));
      const results = game.players.map((p) => ({
        id: p.id,
        placement: p.placement,
        outAt: Math.round(p.stats.outAt),
        dots: p.stats.dots,
        ghosts: p.stats.ghosts,
        raidersSent: p.stats.raidersSent
      }));
      for (const c of this.members) c.send({ t: "end", winner: game.winner, results });
      log(`match over room=${this.code ?? "quick"} winner=${game.players[game.winner]?.name} t=${Math.round(game.time)}s`);
    }
  }
  snapshot(c) {
    const game = this.game;
    const me = game.players[c.slot];
    const viewer = me && me.state === "out" && c.view >= 0 ? game.players[c.view] : me;
    const center = game.mazeAt(viewer.x, viewer.y);
    const near = new Set(neighborhood(center));
    const P = [], Q = [];
    for (const p of game.players) {
      if (p.id === c.slot || p.id === viewer.id || p.state !== "out" && near.has(game.mazeAt(p.x, p.y))) P.push(playerRow(game, p.id));
      else Q.push(farRow(game, p.id));
    }
    const full = this.tick - c.fullAt >= 180 || c.mazeRows.length === 0;
    if (full) c.fullAt = this.tick;
    const M = [];
    for (const m of game.mazes) {
      const row = mazeRow(m);
      const key2 = JSON.stringify(row);
      if (full || c.mazeRows[m.idx] !== key2) {
        M.push(row);
        c.mazeRows[m.idx] = key2;
      }
    }
    const snap = {
      t: "snap",
      tick: this.tick,
      time: Math.round(game.time * 1e3) / 1e3,
      cd: Math.round(game.countdown * 100) / 100,
      over: game.over ? 1 : 0,
      win: game.winner,
      ack: c.ack,
      P,
      Q,
      M,
      G: ghostRows(game, near),
      R: raiderRows(game, near)
    };
    if (c.debt > 0) snap.debt = c.debt;
    const drops = JSON.stringify(game.airdrops.map((a) => [a.id, a.maze, a.x, a.y]));
    if (drops !== c.airdrops) {
      snap.A = JSON.parse(drops);
      c.airdrops = drops;
    }
    const PL = [];
    for (const idx of near) {
      const m = game.mazes[idx];
      if (c.pelletVer.get(idx) !== m.pelletVer) {
        PL.push([idx, m.pelletVer, encodePellets(m.pellets)]);
        c.pelletVer.set(idx, m.pelletVer);
      }
    }
    for (const idx of [...c.pelletVer.keys()]) if (!near.has(idx)) c.pelletVer.delete(idx);
    if (PL.length) snap.PL = PL;
    const E = this.events.filter((e) => e.player === c.slot || e.f === 1 || e.maze !== void 0 && near.has(e.maze) || (e.target ?? []).some((t) => near.has(t)) || e.kind === "count" || e.kind === "win");
    if (E.length) snap.E = E;
    return snap;
  }
};
var rooms = /* @__PURE__ */ new Map();
var tokens = /* @__PURE__ */ new Map();
var quickRoom = null;
function newCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  for (; ; ) {
    let code = "";
    for (let i = 0; i < 4; i++) code += letters[crypto.randomInt(letters.length)];
    if (!rooms.has(code)) return code;
  }
}
function closeRoom(room) {
  if (room.code) rooms.delete(room.code);
  if (quickRoom === room) quickRoom = null;
  for (const s of room.seats) tokens.delete(s.token);
  for (const c of room.members) c.room = null;
  room.members.clear();
  allRooms.delete(room);
}
var allRooms = /* @__PURE__ */ new Set();
function handle(c, msg) {
  switch (msg.t) {
    case "hello": {
      if (msg.v !== PROTOCOL) {
        c.send({ t: "error", msg: "Your game is out of date. Reload the page." });
        return;
      }
      c.name = (String(msg.name ?? "").toUpperCase().replace(/[^A-Z0-9 _-]/g, "").trim() || "PLAYER").slice(0, 10);
      if (msg.token && tokens.has(msg.token)) {
        const { room, slot } = tokens.get(msg.token);
        const seat = room.seats[slot];
        if (room.state === "playing" && seat && !seat.conn) {
          c.token = msg.token;
          room.rejoin(c, slot);
          c.send({ t: "welcome", token: c.token });
          return;
        }
      }
      c.send({ t: "welcome", token: c.token });
      return;
    }
    case "quick": {
      if (c.room) c.room.remove(c);
      if (!quickRoom || quickRoom.state !== "lobby") {
        if (allRooms.size >= MAX_ROOMS) {
          c.send({ t: "error", msg: "The server is full right now. Try again soon." });
          return;
        }
        quickRoom = new Room(null);
        allRooms.add(quickRoom);
      }
      const room = quickRoom;
      room.add(c);
      return;
    }
    case "create": {
      if (c.room) c.room.remove(c);
      if (allRooms.size >= MAX_ROOMS) {
        c.send({ t: "error", msg: "The server is full right now. Try again soon." });
        return;
      }
      const room = new Room(newCode());
      rooms.set(room.code, room);
      allRooms.add(room);
      room.add(c);
      return;
    }
    case "join": {
      const room = rooms.get(String(msg.code ?? "").toUpperCase().trim());
      if (!room) {
        c.send({ t: "error", msg: "No room with that code." });
        return;
      }
      if (room.state !== "lobby") {
        c.send({ t: "error", msg: "That match has already started." });
        return;
      }
      if (room.members.size >= MAX_HUMANS) {
        c.send({ t: "error", msg: "That room is full." });
        return;
      }
      if (c.room) c.room.remove(c);
      room.add(c);
      return;
    }
    case "start": {
      const room = c.room;
      if (room && !room.isQuick && room.host === c && room.state === "lobby") room.start();
      return;
    }
    case "leave": {
      const room = c.room;
      if (!room) return;
      room.remove(c);
      if (room.state !== "lobby") {
        tokens.delete(c.token);
        c.token = crypto.randomBytes(12).toString("hex");
        c.send({ t: "welcome", token: c.token });
      }
      c.send({ t: "left" });
      return;
    }
    case "in": {
      if (!c.room || c.slot < 0 || !Array.isArray(msg.f)) return;
      for (const fr of msg.f.slice(0, 40)) {
        const seq = Number(fr[0]), next = Number(fr[1]);
        if (!Number.isFinite(seq) || !(next >= -1 && next <= 3 || next >= FROZEN - 1 && next <= FROZEN + 3)) continue;
        if (seq <= c.ack || c.frames.length && seq <= c.frames[c.frames.length - 1][0]) continue;
        c.frames.push([seq, Math.trunc(next)]);
      }
      return;
    }
    case "power":
      c.power = true;
      return;
    case "view":
      c.view = Number.isInteger(msg.id) ? msg.id : -1;
      return;
    case "ping":
      c.send({ t: "pong", c: Number(msg.c) || 0 });
      return;
  }
}
var last = performance.now();
var acc = 0;
function loop() {
  const now = performance.now();
  acc += Math.min(0.25, (now - last) / 1e3) * SPEED;
  last = now;
  let steps = 0;
  while (acc >= TICK && steps < 5 * SPEED) {
    acc -= TICK;
    steps++;
    for (const room of allRooms) {
      if (room.state === "lobby" && room.isQuick && room.startsAt && Date.now() >= room.startsAt) room.start();
      if (room.state === "playing") room.step();
      else if (room.state === "over" && Date.now() - room.endedAt > ROOM_LINGER) closeRoom(room);
    }
  }
  setTimeout(loop, Math.max(0, (TICK - acc) * 1e3 - 1));
}
setInterval(() => {
  for (const room of allRooms) if (room.state === "lobby" && room.isQuick) room.broadcastLobby();
}, 1e3);
var page = "";
function loadPage() {
  try {
    page = fs.readFileSync(CLIENT, "utf8").replace('<meta name="maze-online" content="0">', '<meta name="maze-online" content="1">');
  } catch {
    page = "<!doctype html><title>Maze Royale</title><p>Client not built. Run <code>npm run build</code>.</p>";
  }
}
loadPage();
var server = http.createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  if (url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (url === "/" || url === "/index.html") {
    if (process.env.NODE_ENV !== "production") loadPage();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    res.end(page);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});
var wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16 * 1024 });
wss.on("connection", (ws, req) => {
  const ip = String(req.headers["fly-client-ip"] ?? req.socket.remoteAddress ?? "");
  const c = new Conn(ws, ip);
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.t !== "string") return;
    handle(c, msg);
  });
  ws.on("pong", () => {
    c.alive = true;
  });
  ws.on("close", () => {
    if (c.room) c.room.remove(c);
  });
  ws.on("error", () => {
  });
});
setInterval(() => {
  for (const room of allRooms) {
    for (const c of room.members) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }
}, 1e4);
server.listen(PORT, () => {
  log(`Maze Royale server on :${PORT} (client: ${CLIENT})`);
  loop();
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => {
  log("shutting down");
  process.exit(0);
});
