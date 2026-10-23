// CPU Pac-Men. At each tile center a bot runs a short BFS from its position, scores
// each first step by the value it can reach (pellets, fruit, frightened ghosts,
// airdrops) minus how exposed that route is to threats (a multi-source BFS from
// nearby ghosts and raiders), and takes the best. Skill controls how far it looks
// for danger, how often it panic-reverses and how noisy its choices are.

import * as C from './config';
import { DX, DY, opposite, wrapDelta, wrapX, wrapY } from './movement';
import { P_DOT, P_POWER, isWalkableCode } from './maze';
import type { Rng } from './rng';
import type { Game } from './game';
import type { BotBrain, Player } from './types';

const N = C.WORLD_W * C.WORLD_H;
const stamp = new Int32Array(N);
const dist = new Int16Array(N);
const first = new Int8Array(N);
const tStamp = new Int32Array(N);
const tDist = new Int32Array(N);
const queue = new Int32Array(N);
let gen = 0;
let tGen = 0;

const MAX_DEPTH = 40;
const MAX_NODES = 5000;
const REGION_DEPTH = 16; // escape room is judged within this many steps
const THREAT_DEPTH = 16;

/** Debug hook: set `name` to log one bot's decisions (used by diagnostics, not the game). */
export const botDebug = { name: '', log: [] as string[] };

export function makeBrain(rng: Rng): BotBrain {
  return {
    skill: rng.range(0.45, 0.95),
    aggression: rng.range(0.2, 1),
    useDelay: rng.range(1, 5),
    goalMaze: -1,
    goalX: 0,
    goalY: 0,
    goalTimer: 0,
    thinkTimer: 0,
    lastReverse: -10,
  };
}

function walkable(game: Game, x: number, y: number): boolean {
  const mi = Math.floor(x / C.MW) + Math.floor(y / C.MH) * C.GRID;
  const m = game.mazes[mi];
  if (m.collapsed) return false;
  return isWalkableCode(m.layout.tiles[(y % C.MH) * C.MW + (x % C.MW)]);
}

/**
 * A threat, how long (in tenths of a Pac-Man tile-step) before it becomes dangerous,
 * and how many tenths each tile costs it (slower things cost more).
 */
interface Threat { x: number; y: number; delay: number; step: number; dir?: number }

const UNIT = 10; // threat-field resolution: 10 units = one tile at Pac-Man speed
const mazeOf = (x: number, y: number) => Math.floor(x / C.MW) + Math.floor(y / C.MH) * C.GRID;

function gatherThreats(game: Game, p: Player, radius: number, blind: boolean): Threat[] {
  const out: Threat[] = [];
  // Everything in our own maze counts (the side tunnel makes "far" things close);
  // things in other mazes only when they're nearby.
  const near = (x: number, y: number) =>
    (!blind && mazeOf(wrapX(Math.round(x)), wrapY(Math.round(y))) === p.maze) ||
    (Math.abs(wrapDelta(x - p.x, C.WORLD_W)) <= radius && Math.abs(wrapDelta(y - p.y, C.WORLD_H)) <= radius);
  const pac = (maze: number) => game.pacSpeed(game.mazes[maze].level);
  const units = (seconds: number, maze: number) => Math.round(seconds * pac(maze) * UNIT);
  for (const g of game.ghosts) {
    const m = game.mazes[g.maze];
    // Assume ghosts are at least as fast as us: being optimistic here gets bots killed.
    const step = Math.min(UNIT, Math.round(UNIT / game.ghostChaseRatio(g)));
    if (g.state === 'house') {
      const ex = m.ox + C.HOUSE_EXIT.x, ey = m.oy + C.HOUSE_EXIT.y;
      if (g.timer < 2 && near(ex, ey)) out.push({ x: ex, y: ey, delay: units(Math.max(0, g.timer), g.maze), step });
      continue;
    }
    if (g.state !== 'active' || !near(g.x, g.y)) continue;
    // A frightened ghost becomes dangerous again when the fright runs out.
    const delay = game.isFrightened(g) ? units(m.frightTimer, g.maze) : 0;
    out.push({ x: g.x, y: g.y, delay, step, dir: g.dir });
  }
  for (const r of game.raiders) {
    if (r.dead || !near(r.x, r.y)) continue;
    const m = game.mazes[r.maze];
    const wait = Math.max(r.materialize, m.frightTimer + (m.frightTimer > 0 ? C.RAIDER_THAW_GRACE : r.grace), 0);
    const step = Math.round(UNIT * pac(r.maze) / (C.PAC_SPEED_BASE * C.RAIDER_SPEED_FACTOR));
    out.push({ x: r.x, y: r.y, delay: units(wait, r.maze), step, dir: r.dir });
  }
  return out;
}

const MAX_UNITS = THREAT_DEPTH * UNIT;
const buckets: number[][] = [];
const tStep = new Uint8Array(N);

/**
 * Dial's-algorithm search of the earliest time each tile could be reached by a threat,
 * in UNITs. Threats never leave their own maze and can't pass through the bot itself.
 */
function threatField(game: Game, threats: Threat[], self: number) {
  tGen++;
  tStamp[self] = tGen;
  tDist[self] = 0;
  for (let i = 0; i <= MAX_UNITS; i++) (buckets[i] ??= []).length = 0;
  for (const t of threats) {
    const d0 = Math.max(0, t.delay);
    if (d0 > MAX_UNITS) continue;
    // Round toward where it's heading, so a ghost half a tile away counts as there.
    const lead = t.dir !== undefined && t.dir >= 0 ? 0.49 : 0;
    const tx = Math.round(t.x + (lead ? DX[t.dir!] * lead : 0));
    const ty = Math.round(t.y + (lead ? DY[t.dir!] * lead : 0));
    const k = wrapY(ty) * C.WORLD_W + wrapX(tx);
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
      const x = k % C.WORLD_W, y = (k / C.WORLD_W) | 0;
      const mz = mazeOf(x, y);
      for (let dir = 0; dir < 4; dir++) {
        let nx = wrapX(x + DX[dir]);
        const ny = wrapY(y + DY[dir]);
        if (ny % C.MH === C.TUNNEL_ROW) {
          const lx = x % C.MW;
          if (lx === 0 && dir === 1) nx = x + C.MW - 1;
          else if (lx === C.MW - 1 && dir === 3) nx = x - (C.MW - 1);
        }
        const nk = ny * C.WORLD_W + nx;
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

function pickGoal(game: Game, p: Player, b: BotBrain) {
  const cands = new Set<number>([...game.neighborTargets(p.maze), p.home]);
  let best = -1, bs = -Infinity;
  for (const i of cands) {
    const m = game.mazes[i];
    if (m.collapsed || m.collapseTimer > 0) continue;
    let s = m.dotsLeft - m.level * 20 - m.raiderCount * 30 + game.rng.next() * 25;
    if (m.fruit) s += m.owner !== p.id ? 60 + 60 * b.aggression : 40;
    if (i === p.maze) s -= 15;
    if (s > bs) { bs = s; best = i; }
  }
  b.goalMaze = best;
  b.goalTimer = 6 + game.rng.next() * 6;
  if (best >= 0) {
    const m = game.mazes[best];
    const left = m.layout.dotTiles.filter((i) => m.pellets[i] !== 0);
    const i = game.rng.pick(left.length ? left : m.layout.dotTiles);
    b.goalX = m.ox + (i % C.MW);
    b.goalY = m.oy + Math.floor(i / C.MW);
  }
}

export function botDecide(game: Game, p: Player) {
  const b = p.bot!;
  const cx = Math.round(p.x), cy = Math.round(p.y);
  const here = game.mazes[p.maze];

  // --- threats ---
  const blind = here.blackout > 0;
  const radius = blind ? 3 : Math.round(5 + b.skill * 8);
  const threats = gatherThreats(game, p, radius, blind);
  threatField(game, threats, wrapY(Math.round(p.y)) * C.WORLD_W + wrapX(Math.round(p.x)));

  // --- value of things we could go for ---
  const special = new Map<number, number>();
  const key = (x: number, y: number) => wrapY(Math.round(y)) * C.WORLD_W + wrapX(Math.round(x));
  const away = p.maze !== p.home;
  for (const g of game.ghosts) {
    if (!game.isFrightened(g)) continue;
    const m = game.mazes[g.maze];
    const reach = Math.abs(wrapDelta(g.x - p.x, C.WORLD_W)) + Math.abs(wrapDelta(g.y - p.y, C.WORLD_H));
    if (reach / game.pacSpeed(m.level) > m.frightTimer * 0.85) continue;
    special.set(key(g.x, g.y), 8 + (away ? 10 * b.aggression : 0));
  }
  for (const m of game.mazes) {
    if (!m.fruit || m.collapsed) continue;
    special.set(key(m.ox + C.FRUIT.x, m.oy + C.FRUIT.y), m.owner === p.id ? 4 : 8 + 14 * b.aggression);
  }
  if (p.slot === null) for (const a of game.airdrops) special.set(key(a.x, a.y), 7);
  const rivalCharging = game.inMaze[p.maze].some((q) => q !== p && q.dazeCharge > 0);
  const fleeMaze = rivalCharging || here.collapseTimer > 0;
  const threatNear = threats.length > 0;

  // --- BFS from our tile, only through tiles we reach before any threat can ---
  // This "safe region" view handles danger and value together: pellets behind a
  // ghost simply aren't reachable, and a direction that leads into a closing
  // pincer shows up as a tiny region.
  gen++;
  const start = cy * C.WORLD_W + cx;
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
  const blockedNear = [99, 99, 99, 99]; // threat distance at each first step (for the cornered fallback)
  if (b.goalTimer <= 0 || b.goalMaze < 0 || game.mazes[b.goalMaze].collapsed) pickGoal(game, p, b);
  const gx = b.goalX, gy = b.goalY;
  if (Math.abs(wrapDelta(cx - gx, C.WORLD_W)) + Math.abs(wrapDelta(cy - gy, C.WORLD_H)) < 2) b.goalTimer = 0;
  // Better players keep a bigger margin from threats.
  const margin = b.skill > 0.7 ? 1 : 0;

  for (let h = 0; h < tail; h++) {
    const k = queue[h];
    const d = dist[k];
    const x = k % C.WORLD_W, y = (k / C.WORLD_W) | 0;
    const f = first[k];
    if (f >= 0) {
      const mi = Math.floor(x / C.MW) + Math.floor(y / C.MH) * C.GRID;
      const m = game.mazes[mi];
      const decay = Math.pow(0.88, d);
      const pel = m.pellets[(y % C.MH) * C.MW + (x % C.MW)];
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
      const gd = Math.abs(wrapDelta(x - gx, C.WORLD_W)) + Math.abs(wrapDelta(y - gy, C.WORLD_H));
      const gs = d * 0.35 + gd;
      if (gs < goalScore[f]) goalScore[f] = gs;
    }
    if (d >= MAX_DEPTH) continue;
    for (let dir = 0; dir < 4; dir++) {
      let nx = wrapX(x + DX[dir]);
      const ny = wrapY(y + DY[dir]);
      // tunnel warp
      if (ny % C.MH === C.TUNNEL_ROW) {
        const lx = x % C.MW;
        if (lx === 0 && dir === 1) nx = x + C.MW - 1;
        else if (lx === C.MW - 1 && dir === 3) nx = x - (C.MW - 1);
      }
      const nk = ny * C.WORLD_W + nx;
      if (tail >= MAX_NODES || stamp[nk] === gen || !walkable(game, nx, ny)) continue;
      const threatHere = tStamp[nk] === tGen ? tDist[nk] : 9999;
      if (f < 0) blockedNear[dir] = threatHere;
      if (threatHere <= (d + 1 + margin) * UNIT) continue; // a threat gets there first
      stamp[nk] = gen;
      dist[nk] = d + 1;
      first[nk] = f >= 0 ? f : dir;
      if (f < 0) reachable[dir] = true;
      queue[tail++] = nk;
    }
  }

  // --- choose ---
  const totalReward = reward.reduce((a, c) => a + c, 0);
  const fwdOk = p.dir >= 0 && reachable[p.dir] && region[p.dir] >= 10;
  let best = -1, bs = -Infinity;
  for (let dir = 0; dir < 4; dir++) {
    if (!reachable[dir]) continue;
    let s: number;
    if (totalReward < 0.05) s = -goalScore[dir];
    // Score by the best single target reachable that way (stable as we approach it),
    // plus a little for how much else is down that route.
    else s = best1[dir] * 10 + reward[dir] * 0.4;
    if (threatNear) {
      // Room to run matters more than pellets when something is hunting us.
      // Enough room is enough: saturate so nearby tiles don't flip-flop on huge counts.
      s += Math.min(region[dir], 40) * 0.25 * (0.5 + b.skill);
      if (region[dir] < 25) s -= (25 - region[dir]) * 4 * (0.5 + b.skill);
    }
    // Hysteresis: only turn around for a real reason. If the way ahead is still safe,
    // a recent turnaround makes another one very expensive (stops dithering loops).
    if (dir === opposite(p.dir) && fwdOk) s -= (threatNear ? 5 : 3) + (game.time - b.lastReverse < 1.5 ? 60 : 0);
    s += (game.rng.next() - 0.5) * (1.5 - b.skill) * 2;
    if (s > bs) { bs = s; best = dir; }
  }
  if (best < 0) {
    // Cornered: every step is reachable by a threat first. Run toward the farthest one.
    let bd = -1;
    for (let dir = 0; dir < 4; dir++) {
      if (!walkable(game, wrapX(cx + DX[dir]), wrapY(cy + DY[dir]))) continue;
      if (blockedNear[dir] > bd) { bd = blockedNear[dir]; best = dir; }
    }
  }
  if (botDebug.name === p.name || (botDebug as { all?: boolean }).all) {
    const f = (a: number[]) => a.map((v) => v.toFixed(1)).join(',');
    botDebug.log.push(`${(botDebug as { all?: boolean }).all ? p.id + "|" : ""}${game.time.toFixed(2)} @${cx % C.MW},${cy % C.MH} dir${p.dir} best[${f(best1)}] region[${region}] thr ${threats.map((t) => `(${(t.x % C.MW).toFixed(1)},${(t.y % C.MH).toFixed(1)}+${t.delay}/${t.step})`).join('')} -> ${best}`);
  }
  if (best >= 0 && best === opposite(p.dir)) b.lastReverse = game.time;
  if (best >= 0) p.next = best;
}

export function botUpdate(game: Game, p: Player, dt: number) {
  const b = p.bot!;
  b.goalTimer -= dt;
  b.thinkTimer -= dt;

  // Panic reverse when something deadly is right ahead.
  if (b.thinkTimer <= 0 && p.dir >= 0 && p.daze <= 0) {
    b.thinkTimer = 0.1;
    if (p.invuln <= 0 && game.rng.chance(0.35 + b.skill * 0.6)) {
      const ax = p.x + DX[p.dir] * 1.5, ay = p.y + DY[p.dir] * 1.5;
      const deadly = (x: number, y: number) =>
        Math.abs(wrapDelta(x - ax, C.WORLD_W)) < 1.3 && Math.abs(wrapDelta(y - ay, C.WORLD_H)) < 1.3;
      let hit = false;
      for (const g of game.ghosts) {
        if (g.maze !== p.maze || g.state !== 'active' || game.isFrightened(g)) continue;
        if (deadly(g.x, g.y)) { hit = true; break; }
      }
      if (!hit) for (const r of game.raiders) if (r.maze === p.maze && game.raiderHarmful(r) && deadly(r.x, r.y)) { hit = true; break; }
      if (hit) p.next = opposite(p.dir);
    }
  }

  // Power-ups.
  if (p.slot) {
    b.useDelay -= dt;
    if (b.useDelay > 0) return;
    if (p.slot === 'daze') {
      const rivals = game.inMaze[p.maze].filter((q) => q !== p && q.invuln <= 0);
      const exposed = rivals.some((q) =>
        game.ghosts.some((g) => g.maze === q.maze && g.state === 'active' && !game.isFrightened(g) &&
          Math.abs(g.x - q.x) + Math.abs(g.y - q.y) < 7));
      if (exposed || (rivals.length > 0 && b.useDelay < -8)) game.usePower(p);
    } else {
      const targets = game.neighborTargets(p.maze).filter((t) => game.inMaze[t].length > 0);
      if (targets.length > 0) game.usePower(p);
    }
    if (!p.slot) b.useDelay = 1 + game.rng.next() * 4;
  }
}
