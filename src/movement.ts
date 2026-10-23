// Tile-based movement shared by Pac-Men, ghosts and raiders.
// Positions are in world tile units with tile centers on integers. Movers only turn
// at tile centers; a buffered `next` direction is applied as soon as it's legal,
// which gives the forgiving "pre-turn" feel. Reversing is allowed mid-tile.

import { MW, MH, WORLD_W, WORLD_H, TUNNEL_ROW } from './config';

export const UP = 0, LEFT = 1, DOWN = 2, RIGHT = 3;
export const DX = [0, -1, 0, 1];
export const DY = [-1, 0, 1, 0];
export const opposite = (d: number) => (d < 0 ? -1 : (d + 2) % 4);

export interface Mover {
  x: number;
  y: number;
  dir: number; // -1 = stopped
  next: number; // buffered direction, -1 = none
}

export const wrapX = (x: number) => ((x % WORLD_W) + WORLD_W) % WORLD_W;
export const wrapY = (y: number) => ((y % WORLD_H) + WORLD_H) % WORLD_H;

export function wrapDelta(d: number, size: number): number {
  if (d > size / 2) return d - size;
  if (d < -size / 2) return d + size;
  return d;
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = wrapDelta(ax - bx, WORLD_W);
  const dy = wrapDelta(ay - by, WORLD_H);
  return dx * dx + dy * dy;
}

const EPS = 1e-6;

export interface MoveOptions {
  canEnter: (tx: number, ty: number) => boolean;
  atCenter?: (m: Mover) => void;
  tunnel?: boolean; // may use the side tunnel warp
}

/** Advances a mover by `dist` tiles. Returns true if it is stopped against a wall. */
export function move(m: Mover, dist: number, opt: MoveOptions): boolean {
  let guard = 0;
  let stopped = false;
  let justWarped = false;
  while (dist > EPS && guard++ < 16) {
    const cx = Math.round(m.x), cy = Math.round(m.y);
    const atC = Math.abs(m.x - cx) < EPS && Math.abs(m.y - cy) < EPS;
    if (atC) {
      m.x = cx;
      m.y = cy;
      // Don't re-decide on the tile we just warped onto (avoids bouncing back through).
      if (!justWarped) opt.atCenter?.(m);
      justWarped = false;
      // Side tunnel: stepping off the maze's edge on the tunnel row warps to the
      // other side of the same maze (never into the neighbor).
      const lx = ((cx % MW) + MW) % MW;
      const tunnelRow = opt.tunnel && ((cy % MH) + MH) % MH === TUNNEL_ROW;
      const warpDir = tunnelRow ? (lx === 0 ? LEFT : lx === MW - 1 ? RIGHT : -1) : -1;
      const canGo = (d: number) => d === warpDir || opt.canEnter(cx + DX[d], cy + DY[d]);
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
      const step = Math.min(dist, 1);
      m.x += DX[m.dir] * step;
      m.y += DY[m.dir] * step;
      dist -= step;
      if (step === 1) { m.x = Math.round(m.x); m.y = Math.round(m.y); }
    } else {
      if (m.dir < 0) { m.x = cx; m.y = cy; continue; }
      if (m.next >= 0 && m.next === opposite(m.dir)) m.dir = m.next;
      const horiz = DX[m.dir] !== 0;
      const p = horiz ? m.x : m.y;
      const s = DX[m.dir] + DY[m.dir];
      const d = s > 0 ? Math.ceil(p - EPS) - p : p - Math.floor(p + EPS);
      const step = Math.min(dist, d);
      if (horiz) m.x += s * step; else m.y += s * step;
      dist -= step;
      if (step >= d - EPS) { m.x = Math.round(m.x); m.y = Math.round(m.y); }
    }
    m.x = wrapX(m.x);
    m.y = wrapY(m.y);
  }
  m.x = wrapX(m.x);
  m.y = wrapY(m.y);
  return stopped;
}
