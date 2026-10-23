// Ghost and raider steering. Ghosts use the classic arcade targeting rules, applied
// to the nearest Pac-Man inside their own maze. Raiders are cruder: they usually
// head for the nearest Pac-Man and sometimes wander.

import * as C from './config';
import { isWalkableCode } from './maze';
import { DX, DY, opposite } from './movement';
import type { Game } from './game';
import type { Ghost, Player, Raider } from './types';

type CanEnter = (tx: number, ty: number) => boolean;

function nearestPac(game: Game, maze: number, x: number, y: number): Player | null {
  let best: Player | null = null, bd = Infinity;
  for (const p of game.inMaze[maze]) {
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

function options(m: { x: number; y: number; dir: number }, canEnter: CanEnter): number[] {
  const cx = Math.round(m.x), cy = Math.round(m.y);
  const rev = opposite(m.dir);
  const out: number[] = [];
  for (let d = 0; d < 4; d++) if (d !== rev && canEnter(cx + DX[d], cy + DY[d])) out.push(d);
  if (out.length === 0 && rev >= 0 && canEnter(cx + DX[rev], cy + DY[rev])) out.push(rev);
  return out;
}

function towards(m: { x: number; y: number }, opts: number[], tx: number, ty: number): number {
  const cx = Math.round(m.x), cy = Math.round(m.y);
  let best = opts[0], bd = Infinity;
  for (const d of opts) {
    const nx = cx + DX[d], ny = cy + DY[d];
    const dd = (nx - tx) ** 2 + (ny - ty) ** 2;
    if (dd < bd) { bd = dd; best = d; }
  }
  return best;
}

/**
 * Shortest-path distance (in tiles) from every walkable tile of a maze layout to the
 * ghost-house exit. Eyes follow this downhill. Greedy straight-line steering, which
 * live ghosts use, can circle forever in some generated layouts.
 */
const homeDist = new WeakMap<object, Int16Array>();

function homeField(game: Game, maze: number): Int16Array {
  const layout = game.mazes[maze].layout;
  let d = homeDist.get(layout);
  if (d) return d;
  d = new Int16Array(C.MW * C.MH).fill(-1);
  const start = C.HOUSE_EXIT.y * C.MW + C.HOUSE_EXIT.x;
  d[start] = 0;
  const q = [start];
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    const x = i % C.MW, y = Math.floor(i / C.MW);
    for (let k = 0; k < 4; k++) {
      const nx = x + DX[k], ny = y + DY[k];
      if (nx < 0 || ny < 0 || nx >= C.MW || ny >= C.MH) continue;
      const j = ny * C.MW + nx;
      if (d[j] >= 0 || !isWalkableCode(layout.tiles[j])) continue;
      d[j] = d[i] + 1;
      q.push(j);
    }
  }
  homeDist.set(layout, d);
  return d;
}

export function chooseGhostDir(game: Game, g: Ghost, canEnter: CanEnter) {
  const m = game.mazes[g.maze];
  if (g.state === 'eyes') {
    const field = homeField(game, g.maze);
    const cx = Math.round(g.x), cy = Math.round(g.y);
    let best = -1, bd = Infinity;
    for (let k = 0; k < 4; k++) {
      // Eyes may turn around; they just take the shortest way home.
      if (!canEnter(cx + DX[k], cy + DY[k])) continue;
      const lx = cx + DX[k] - m.ox, ly = cy + DY[k] - m.oy;
      if (lx < 0 || ly < 0 || lx >= C.MW || ly >= C.MH) continue;
      const v = field[ly * C.MW + lx];
      if (v >= 0 && v < bd) { bd = v; best = k; }
    }
    g.next = best;
    if (best >= 0) g.dir = best;
    return;
  }
  const opts = options(g, canEnter);
  if (opts.length === 0) { g.next = -1; return; }
  if (game.isFrightened(g)) {
    g.next = game.rng.pick(opts);
    return;
  }
  const pac = nearestPac(game, g.maze, g.x, g.y);
  const elroy = g.kind === 0 && m.dotsLeft <= C.ELROY_PELLETS[m.level];
  const chase = pac && (m.mode === 'chase' || m.frenzy > 0 || elroy);
  let tx: number, ty: number;
  const corners = [[C.MW - 2, -3], [1, -3], [C.MW - 2, C.MH + 2], [1, C.MH + 2]];
  if (!chase || !pac) {
    tx = m.ox + corners[g.kind][0];
    ty = m.oy + corners[g.kind][1];
  } else {
    const px = Math.round(pac.x), py = Math.round(pac.y);
    const f = pac.face >= 0 ? pac.face : 0;
    switch (g.kind) {
      case 0: tx = px; ty = py; break;
      case 1: tx = px + DX[f] * 4; ty = py + DY[f] * 4; break;
      case 2: {
        const ax = px + DX[f] * 2, ay = py + DY[f] * 2;
        const lead = game.ghosts.find((o) => o.maze === g.maze && o.kind === 0 && o.state === 'active');
        const bx = lead ? Math.round(lead.x) : px, by = lead ? Math.round(lead.y) : py;
        tx = ax + (ax - bx);
        ty = ay + (ay - by);
        break;
      }
      default: {
        const d2 = (px - g.x) ** 2 + (py - g.y) ** 2;
        if (d2 > 64) { tx = px; ty = py; } else { tx = m.ox + corners[3][0]; ty = m.oy + corners[3][1]; }
      }
    }
  }
  g.next = towards(g, opts, tx, ty);
}

export function chooseRaiderDir(game: Game, r: Raider, canEnter: CanEnter) {
  const opts = options(r, canEnter);
  if (opts.length === 0) { r.next = -1; r.dir = -1; return; }
  const pac = nearestPac(game, r.maze, r.x, r.y);
  if (pac && game.rng.chance(C.RAIDER_CHASE_CHANCE)) r.next = towards(r, opts, Math.round(pac.x), Math.round(pac.y));
  else r.next = game.rng.pick(opts);
  if (r.dir < 0) r.dir = r.next;
}
