// Turns a maze layout into neon wall line segments. Walls are drawn through the
// middle of wall tiles (not along their edges), so every corridor reads as two
// tiles wide and characters can be drawn large.

import { MW, MH } from './config';
import { T_WALL, type MazeLayout } from './maze';

export interface Segment { x1: number; y1: number; x2: number; y2: number } // in tile units, tile centers at .5

export function wallSegments(layout: MazeLayout): Segment[] {
  const t = layout.tiles;
  const inside = (r: number, c: number) => r >= 0 && r < MH && c >= 0 && c < MW;
  const isOpen = (r: number, c: number) => !inside(r, c) || t[r * MW + c] !== T_WALL;
  const isWall = (r: number, c: number) => inside(r, c) && t[r * MW + c] === T_WALL;
  const edge = (r: number, c: number) => {
    if (!isWall(r, c)) return false;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if ((dr || dc) && isOpen(r + dr, c + dc)) return true;
    return false;
  };
  const segs: Segment[] = [];
  for (let r = 0; r < MH; r++) {
    for (let c = 0; c < MW; c++) {
      if (!edge(r, c)) continue;
      if (edge(r, c + 1) && (isOpen(r - 1, c) || isOpen(r - 1, c + 1) || isOpen(r + 1, c) || isOpen(r + 1, c + 1)))
        segs.push({ x1: c + 0.5, y1: r + 0.5, x2: c + 1.5, y2: r + 0.5 });
      if (edge(r + 1, c) && (isOpen(r, c - 1) || isOpen(r + 1, c - 1) || isOpen(r, c + 1) || isOpen(r + 1, c + 1)))
        segs.push({ x1: c + 0.5, y1: r + 0.5, x2: c + 0.5, y2: r + 1.5 });
    }
  }
  return mergeCollinear(segs);
}

/** Joins touching collinear unit segments into long runs (fewer strokes, smoother gradients). */
function mergeCollinear(segs: Segment[]): Segment[] {
  const horiz = segs.filter((s) => s.y1 === s.y2).sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);
  const vert = segs.filter((s) => s.x1 === s.x2).sort((a, b) => a.x1 - b.x1 || a.y1 - b.y1);
  const out: Segment[] = [];
  for (const list of [horiz, vert]) {
    let cur: Segment | null = null;
    for (const s of list) {
      if (cur && cur.y1 === cur.y2 && s.y1 === cur.y1 && s.x1 === cur.x2) { cur.x2 = s.x2; continue; }
      if (cur && cur.x1 === cur.x2 && s.x1 === cur.x1 && s.y1 === cur.y2) { cur.y2 = s.y2; continue; }
      if (cur) out.push(cur);
      cur = { ...s };
    }
    if (cur) out.push(cur);
  }
  return out;
}
