// Ghost and raider steering. Ghosts use the classic arcade targeting rules, applied
// to the nearest Pac-Man inside their own maze. Raiders are cruder: they usually
// head for the nearest Pac-Man and sometimes wander.

import * as C from './config';
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

export function chooseGhostDir(game: Game, g: Ghost, canEnter: CanEnter) {
  const opts = options(g, canEnter);
  if (opts.length === 0) { g.next = -1; return; }
  const m = game.mazes[g.maze];
  if (g.state === 'eyes') {
    g.next = towards(g, opts, m.ox + C.HOUSE_EXIT.x, m.oy + C.HOUSE_EXIT.y);
    return;
  }
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
