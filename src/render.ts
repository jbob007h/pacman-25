// Canvas renderer. Draws a fixed 1600x900 logical screen: the maze the viewed
// player is in fills the middle, with strips of the 8 surrounding mazes around it.
// The camera snaps (with a short slide) to whichever maze the player is in.

import * as C from './config';
import { P_DOT, P_POWER } from './maze';
import { DX, DY, wrapDelta } from './movement';
import { wallSegments, type Segment } from './walls';
import type { Game } from './game';
import type { GameEvent, Player, Raider } from './types';

export const VIEW_W = 1600;
export const VIEW_H = 900;
const TS = 30; // tile size in px
const OX = 200; // screen position of the viewed maze's top-left
const OY = 120;
const PAD = 24;
const MAZE_PX_W = C.MW * TS;
const MAZE_PX_H = C.MH * TS;
const GHOST_COLORS = ['#FF5A5F', '#34F5A5', '#E8ECFF', '#7FD8FF'];
const SLIDE_TIME = 0.18;

interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number }
interface Ring { x: number; y: number; life: number; max: number; color: string; r0: number; r1: number }

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scale = 1;
  private wallCache = new Map<string, HTMLCanvasElement>();
  private segCache = new Map<number, Segment[]>();
  private camX = 0; // world tile coords of the top-left of the viewed maze (animated)
  private camY = 0;
  private camFromX = 0;
  private camFromY = 0;
  private camT = 1;
  private viewMaze = -1;
  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private trails = new Map<number, { x: number; y: number }[]>();
  private nearMiss = 0;
  private gameRef: Game | null = null;
  time = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.resize(1);
  }

  resize(scale: number) {
    if (scale !== this.scale) this.wallCache.clear();
    this.scale = scale;
    this.canvas.width = Math.round(VIEW_W * scale);
    this.canvas.height = Math.round(VIEW_H * scale);
  }

  /** Feeds simulation events to the visual effects. */
  onEvents(game: Game, events: GameEvent[], viewer: Player | null) {
    for (const e of events) {
      if (e.x === undefined || e.y === undefined) {
        continue;
      }
      switch (e.kind) {
        case 'dot': this.burst(e.x, e.y, '#F4E9C8', 3, 1.2, 0.25); break;
        case 'power': this.ring(e.x, e.y, '#FFF3D1', 0.5, 0.4, 6); this.burst(e.x, e.y, '#FFF3D1', 12, 4, 0.5); break;
        case 'ghost': this.ring(e.x, e.y, e.color ?? '#fff', 0.5, 0.3, 4); this.burst(e.x, e.y, '#9AB0FF', 16, 5, 0.6); break;
        case 'death': this.burst(e.x, e.y, e.color ?? '#FFD84A', 28, 7, 0.9); this.ring(e.x, e.y, e.color ?? '#fff', 0.7, 0.4, 5); break;
        case 'fruit': this.ring(e.x, e.y, '#FF4D5E', 0.8, 0.4, 14); this.burst(e.x, e.y, '#FF8FA0', 24, 6, 0.8); break;
        case 'pickup': this.ring(e.x, e.y, '#7DE3FF', 0.6, 0.3, 6); break;
        default: break;
      }
    }
    void game;
    void viewer;
  }

  private burst(x: number, y: number, color: string, n: number, speed: number, life: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.6);
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life, max: life, color, size: 2 + Math.random() * 2 });
    }
    if (this.particles.length > 600) this.particles.splice(0, this.particles.length - 600);
  }

  private ring(x: number, y: number, color: string, life: number, r0: number, r1: number) {
    this.rings.push({ x, y, color, life, max: life, r0, r1 });
  }

  // ---------- coordinates ----------

  private sx(x: number) { return OX + (wrapDelta(x - (this.camX + C.MW / 2), C.WORLD_W) + C.MW / 2) * TS + TS / 2; }
  private sy(y: number) { return OY + (wrapDelta(y - (this.camY + C.MH / 2), C.WORLD_H) + C.MH / 2) * TS + TS / 2; }
  private visible(px: number, py: number, m = 60) { return px > -m && px < VIEW_W + m && py > -m && py < VIEW_H + m; }

  // ---------- wall art ----------

  private wallCanvas(game: Game, idx: number): HTMLCanvasElement {
    const m = game.mazes[idx];
    const key = `${idx}:${m.collapsed ? 'x' : m.level}`;
    let cv = this.wallCache.get(key);
    if (cv) {
      // keep recently used entries at the end (LRU order)
      this.wallCache.delete(key);
      this.wallCache.set(key, cv);
      return cv;
    }
    // Wall art is soft glow, so it doesn't need full retina resolution.
    const res = Math.min(this.scale, 1.25);
    cv = document.createElement('canvas');
    cv.width = Math.round((MAZE_PX_W + PAD * 2) * res);
    cv.height = Math.round((MAZE_PX_H + PAD * 2) * res);
    const g = cv.getContext('2d')!;
    g.scale(res, res);
    g.translate(PAD, PAD);
    let segs = this.segCache.get(idx);
    if (!segs) { segs = wallSegments(m.layout); this.segCache.set(idx, segs); }
    const path = new Path2D();
    for (const s of segs) {
      path.moveTo(s.x1 * TS, s.y1 * TS);
      path.lineTo(s.x2 * TS, s.y2 * TS);
    }
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (m.collapsed) {
      g.strokeStyle = '#3A4060';
      g.globalAlpha = 0.5;
      g.lineWidth = 3;
      g.stroke(path);
    } else {
      const [c1, c2, c3] = C.LEVEL_PALETTE[m.level];
      const grad = g.createLinearGradient(0, 0, MAZE_PX_W, MAZE_PX_H);
      grad.addColorStop(0, c1);
      grad.addColorStop(0.3, c2);
      grad.addColorStop(0.55, c3);
      grad.addColorStop(0.8, c2);
      grad.addColorStop(1, c1);
      // soft outer glow
      g.globalAlpha = 0.22;
      g.strokeStyle = grad;
      g.lineWidth = 12;
      g.shadowColor = c2;
      g.shadowBlur = 18;
      g.stroke(path);
      // main tube
      g.globalAlpha = 1;
      g.shadowBlur = 8;
      g.lineWidth = 3.5;
      g.stroke(path);
      // hot white core
      g.shadowBlur = 0;
      g.globalAlpha = 0.6;
      g.strokeStyle = '#FFFFFF';
      g.lineWidth = 1.2;
      g.stroke(path);
    }
    this.wallCache.set(key, cv);
    while (this.wallCache.size > 12) this.wallCache.delete(this.wallCache.keys().next().value!);
    return cv;
  }

  // ---------- frame ----------

  render(game: Game, viewer: Player | null, dt: number) {
    if (game !== this.gameRef) {
      // New match: every maze layout changed.
      this.gameRef = game;
      this.wallCache.clear();
      this.segCache.clear();
      this.trails.clear();
      this.particles = [];
      this.rings = [];
      this.viewMaze = -1;
    }
    this.time += dt;
    const ctx = this.ctx;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.fillStyle = '#05060B';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // Camera: snap to the viewed player's maze, with a short slide.
    const target = viewer ? (viewer.state === 'dying' ? this.viewMaze : game.mazeAt(viewer.x, viewer.y)) : 12;
    const tm = game.mazes[target < 0 ? 12 : target];
    if (this.viewMaze !== tm.idx) {
      if (this.viewMaze < 0) { this.camX = tm.ox; this.camY = tm.oy; this.camT = 1; }
      else { this.camFromX = this.camX; this.camFromY = this.camY; this.camT = 0; }
      this.viewMaze = tm.idx;
    }
    if (this.camT < 1) {
      this.camT = Math.min(1, this.camT + dt / SLIDE_TIME);
      const e = 1 - Math.pow(1 - this.camT, 3);
      this.camX = this.camFromX + wrapDelta(tm.ox - this.camFromX, C.WORLD_W) * e;
      this.camY = this.camFromY + wrapDelta(tm.oy - this.camFromY, C.WORLD_H) * e;
    } else { this.camX = tm.ox; this.camY = tm.oy; }

    // Near-miss pulse (client-side only; the simulation never slows down).
    if (viewer && viewer.state === 'alive' && viewer.invuln <= 0) {
      for (const g of game.ghosts) {
        if (g.state !== 'active' || g.maze !== viewer.maze || game.isFrightened(g)) continue;
        const d = Math.hypot(wrapDelta(g.x - viewer.x, C.WORLD_W), wrapDelta(g.y - viewer.y, C.WORLD_H));
        if (d < 1.4) this.nearMiss = Math.max(this.nearMiss, 1);
      }
    }
    this.nearMiss = Math.max(0, this.nearMiss - dt * 2.5);
    const zoom = 1 + this.nearMiss * 0.012;
    if (zoom > 1) {
      ctx.translate(VIEW_W / 2, VIEW_H / 2);
      ctx.scale(zoom, zoom);
      ctx.translate(-VIEW_W / 2, -VIEW_H / 2);
    }

    this.drawMazes(game);
    this.drawPellets(game);
    this.drawPickups(game);
    this.drawGhosts(game);
    this.drawRaiders(game);
    this.drawPlayers(game, viewer, dt);
    this.drawEffects(dt);
    this.drawMazeOverlays(game, viewer);

    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    if (this.nearMiss > 0) {
      const g = ctx.createRadialGradient(VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.35, VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.85);
      g.addColorStop(0, 'rgba(255,40,80,0)');
      g.addColorStop(1, `rgba(255,40,80,${0.22 * this.nearMiss})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }
    this.drawBlackout(game, viewer);
  }

  private drawMazes(game: Game) {
    const ctx = this.ctx;
    const cm = game.mazes[game.mazeAt(this.camX + C.MW / 2, this.camY + C.MH / 2)];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const mx = (cm.mx + dx + C.GRID) % C.GRID, my = (cm.my + dy + C.GRID) % C.GRID;
        const idx = mx + my * C.GRID;
        const m = game.mazes[idx];
        const px = OX + wrapDelta(m.ox - this.camX, C.WORLD_W) * TS;
        const py = OY + wrapDelta(m.oy - this.camY, C.WORLD_H) * TS;
        if (px > VIEW_W || py > VIEW_H || px + MAZE_PX_W < 0 || py + MAZE_PX_H < 0) continue;
        const main = idx === this.viewMaze;
        ctx.globalAlpha = main ? 1 : 0.45;
        if (m.collapseTimer > 0) ctx.globalAlpha *= 0.55 + 0.45 * Math.abs(Math.sin(this.time * 6));
        ctx.drawImage(this.wallCanvas(game, idx), px - PAD, py - PAD, MAZE_PX_W + PAD * 2, MAZE_PX_H + PAD * 2);
        ctx.globalAlpha = 1;
        if (m.collapsed) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(px, py, MAZE_PX_W, MAZE_PX_H);
          ctx.clip();
          ctx.strokeStyle = 'rgba(40,46,70,0.45)';
          ctx.lineWidth = 3;
          for (let k = -MAZE_PX_H; k < MAZE_PX_W; k += 14) {
            ctx.beginPath();
            ctx.moveTo(px + k, py);
            ctx.lineTo(px + k + MAZE_PX_H, py + MAZE_PX_H);
            ctx.stroke();
          }
          ctx.restore();
        } else {
          // ghost house gate
          ctx.fillStyle = '#FF9BD1';
          ctx.globalAlpha = main ? 1 : 0.45;
          ctx.fillRect(px + 18.6 * TS, py + 8.5 * TS - 3, 2.8 * TS, 6);
          ctx.globalAlpha = 1;
        }
        if (main) this.drawDoors(game, m.idx, px, py);
      }
    }
    // seams between mazes
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 8]);
    const sxm = OX + wrapDelta(cm.ox - this.camX, C.WORLD_W) * TS;
    const sym = OY + wrapDelta(cm.oy - this.camY, C.WORLD_H) * TS;
    ctx.beginPath();
    for (const x of [sxm, sxm + MAZE_PX_W]) { ctx.moveTo(x, 0); ctx.lineTo(x, VIEW_H); }
    for (const y of [sym, sym + MAZE_PX_H]) { ctx.moveTo(0, y); ctx.lineTo(VIEW_W, y); }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawDoors(game: Game, idx: number, px: number, py: number) {
    const ctx = this.ctx;
    const m = game.mazes[idx];
    const neighbor = (d: number) => game.mazes[((m.mx + DX[d] + C.GRID) % C.GRID) + ((m.my + DY[d] + C.GRID) % C.GRID) * C.GRID];
    const doors: [number, number, number][] = [
      [C.DOOR_COLS[0], 0, 0], [C.DOOR_COLS[1], 0, 0],
      [C.DOOR_COLS[0], C.MH - 1, 2], [C.DOOR_COLS[1], C.MH - 1, 2],
      [0, C.SIDE_DOOR_ROW, 1], [C.MW - 1, C.SIDE_DOOR_ROW, 3],
    ];
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const [c, r, d] of doors) {
      const cx = px + c * TS + TS / 2, cy = py + r * TS + TS / 2;
      const n = neighbor(d);
      if (n.collapsed) {
        ctx.fillStyle = '#FF4D5E';
        ctx.shadowColor = '#FF4D5E';
        ctx.shadowBlur = 10;
        const ex = cx + DX[d] * 13, ey = cy + DY[d] * 13;
        if (DX[d] === 0) ctx.fillRect(ex - 27, ey - 3, 54, 6); else ctx.fillRect(ex - 3, ey - 27, 6, 54);
        ctx.shadowBlur = 0;
        continue;
      }
      const warn = n.collapseTimer > 0;
      ctx.strokeStyle = warn ? (Math.sin(this.time * 10) > 0 ? '#FF4D5E' : '#FFD0D5') : 'rgba(233,237,255,0.85)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      const ax = DX[d], ay = DY[d];
      const tipX = cx + ax * 4, tipY = cy + ay * 4;
      ctx.moveTo(tipX - ax * 9 - ay * 9, tipY - ay * 9 - ax * 9);
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(tipX - ax * 9 + ay * 9, tipY - ay * 9 + ax * 9);
      ctx.stroke();
    }
    // tunnel warp rings
    ctx.strokeStyle = '#7DE3FF';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([5, 4]);
    ctx.lineDashOffset = -this.time * 20;
    for (const c of [0, C.MW - 1]) {
      ctx.beginPath();
      ctx.arc(px + c * TS + TS / 2, py + C.TUNNEL_ROW * TS + TS / 2, 12, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }

  private drawPellets(game: Game) {
    const ctx = this.ctx;
    const pulse = 0.75 + 0.25 * Math.sin(this.time * 6);
    const cm = game.mazes[game.mazeAt(this.camX + C.MW / 2, this.camY + C.MH / 2)];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const m = game.mazes[((cm.mx + dx + C.GRID) % C.GRID) + ((cm.my + dy + C.GRID) % C.GRID) * C.GRID];
        if (m.collapsed) continue;
        const main = m.idx === this.viewMaze;
        ctx.globalAlpha = main ? 1 : 0.5;
        ctx.fillStyle = '#F4E9C8';
        ctx.beginPath();
        for (let i = 0; i < m.pellets.length; i++) {
          if (m.pellets[i] !== P_DOT) continue;
          const x = this.sx(m.ox + (i % C.MW)), y = this.sy(m.oy + Math.floor(i / C.MW));
          if (!this.visible(x, y, 10)) continue;
          ctx.moveTo(x + 4, y);
          ctx.arc(x, y, 4, 0, Math.PI * 2);
        }
        ctx.fill();
        ctx.fillStyle = '#FFF3D1';
        ctx.shadowColor = '#FFE9A8';
        ctx.shadowBlur = 14;
        for (const i of m.layout.powerTiles) {
          if (m.pellets[i] !== P_POWER) continue;
          const x = this.sx(m.ox + (i % C.MW)), y = this.sy(m.oy + Math.floor(i / C.MW));
          if (!this.visible(x, y, 20)) continue;
          ctx.beginPath();
          ctx.arc(x, y, 11 * pulse, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      }
    }
  }

  private drawPickups(game: Game) {
    const ctx = this.ctx;
    for (const m of game.mazes) {
      if (!m.fruit) continue;
      const x = this.sx(m.ox + C.FRUIT.x), y = this.sy(m.oy + C.FRUIT.y);
      if (!this.visible(x, y)) continue;
      const bob = Math.sin(this.time * 3) * 2;
      ctx.save();
      ctx.translate(x, y + bob);
      ctx.shadowColor = '#FF4D5E';
      ctx.shadowBlur = 16;
      ctx.strokeStyle = '#7CE38B';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(0, -14); ctx.quadraticCurveTo(-2, -4, -8, 2);
      ctx.moveTo(0, -14); ctx.quadraticCurveTo(3, -4, 8, 2);
      ctx.stroke();
      ctx.fillStyle = '#FF4D5E';
      ctx.beginPath(); ctx.arc(-8, 7, 8, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(8, 7, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.beginPath(); ctx.arc(-10, 4, 2, 0, Math.PI * 2); ctx.arc(6, 4, 2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    for (const a of game.airdrops) {
      const x = this.sx(a.x), y = this.sy(a.y);
      if (!this.visible(x, y)) continue;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.sin(this.time * 2) * 0.1);
      ctx.shadowColor = '#7DE3FF';
      ctx.shadowBlur = 18;
      ctx.strokeStyle = '#7DE3FF';
      ctx.lineWidth = 3;
      ctx.strokeRect(-14, -14, 28, 28);
      ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(14, 0); ctx.moveTo(0, -14); ctx.lineTo(0, 14); ctx.stroke();
      ctx.restore();
    }
  }

  private drawGhosts(game: Game) {
    const ctx = this.ctx;
    for (const g of game.ghosts) {
      if (g.state === 'gone') continue;
      const m = game.mazes[g.maze];
      let x = this.sx(g.x), y = this.sy(g.y);
      if (!this.visible(x, y)) continue;
      const main = g.maze === this.viewMaze;
      ctx.save();
      if (g.state === 'house') y += Math.sin(this.time * 5 + g.kind) * 4;
      ctx.translate(x, y);
      ctx.globalAlpha = main ? 1 : 0.55;
      ctx.scale(1.9, 1.9);
      const fright = game.isFrightened(g);
      if (g.state !== 'eyes') {
        let fill = GHOST_COLORS[g.kind];
        if (fright) fill = m.frightTimer < 1 && Math.sin(this.time * 20) > 0 ? '#E8ECFF' : '#2340FF';
        else if (m.frenzy > 0) fill = Math.sin(this.time * 12) > 0 ? '#FF3D2E' : GHOST_COLORS[g.kind];
        ctx.shadowColor = fill;
        ctx.shadowBlur = main ? 10 : 0;
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.moveTo(-11, -10); ctx.lineTo(11, -10); ctx.lineTo(11, 1);
        ctx.quadraticCurveTo(11, 7, 0, 12);
        ctx.quadraticCurveTo(-11, 7, -11, 1);
        ctx.closePath();
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      // visor
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (fright) {
        ctx.strokeStyle = '#E9EDFF';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-7, -2); ctx.lineTo(-3.5, -5); ctx.lineTo(0, -2); ctx.lineTo(3.5, -5); ctx.lineTo(7, -2);
        ctx.stroke();
      } else {
        ctx.strokeStyle = g.state === 'eyes' ? '#E9EDFF' : '#05060B';
        ctx.lineWidth = 3;
        const lx = g.dir >= 0 ? DX[g.dir] * 2 : 0, ly = g.dir >= 0 ? DY[g.dir] * 1.5 : 0;
        ctx.beginPath();
        ctx.moveTo(-6 + lx, -3 + ly); ctx.lineTo(6 + lx, -3 + ly);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawRaiders(game: Game) {
    for (const r of game.raiders) {
      if (r.dead) continue;
      const x = this.sx(r.x), y = this.sy(r.y);
      if (!this.visible(x, y)) continue;
      this.drawRaider(game, r, x, y);
    }
  }

  private drawRaider(game: Game, r: Raider, x: number, y: number) {
    const ctx = this.ctx;
    const m = game.mazes[r.maze];
    const sender = game.players[r.sender];
    const frozen = m.frightTimer > 0;
    const main = r.maze === this.viewMaze;
    ctx.save();
    ctx.translate(x, y);
    let alpha = main ? 1 : 0.55;
    if (r.materialize > 0) {
      const t = 1 - r.materialize / C.RAIDER_MATERIALIZE;
      ctx.strokeStyle = sender.color;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 6]);
      ctx.lineDashOffset = this.time * 30;
      ctx.beginPath();
      ctx.arc(0, 0, 40 - t * 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      alpha *= 0.25 + 0.4 * t;
    }
    if (r.life < 2 && Math.sin(this.time * 25) > 0) alpha *= 0.4;
    ctx.globalAlpha = alpha;
    ctx.rotate(frozen ? 0 : this.time * 2);
    ctx.scale(1.75, 1.75);
    ctx.beginPath();
    for (let k = 0; k < 16; k++) {
      const rad = k % 2 === 0 ? 14 : 6;
      const a = (k * 22.5 - 90) * Math.PI / 180;
      if (k === 0) ctx.moveTo(rad * Math.cos(a), rad * Math.sin(a)); else ctx.lineTo(rad * Math.cos(a), rad * Math.sin(a));
    }
    ctx.closePath();
    const thawing = frozen && m.frightTimer < 1 && Math.sin(this.time * 20) > 0;
    ctx.fillStyle = frozen ? (thawing ? sender.color : '#CFF4FF') : sender.color;
    ctx.shadowColor = frozen ? '#BDF1FF' : sender.color;
    ctx.shadowBlur = main ? 12 : 0;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = frozen ? '#FFFFFF' : 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = '#05060B';
    ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fill();
    if (frozen) {
      ctx.strokeStyle = '#5AA9C9';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-5, -9); ctx.lineTo(-1, -3); ctx.lineTo(-4, 3);
      ctx.moveTo(4, -6); ctx.lineTo(1, 1); ctx.lineTo(6, 8);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawPlayers(game: Game, viewer: Player | null, dt: number) {
    const ctx = this.ctx;
    for (const p of game.players) {
      if (p.state === 'out') { this.trails.delete(p.id); continue; }
      const x = this.sx(p.x), y = this.sy(p.y);
      // trail
      let tr = this.trails.get(p.id);
      if (!tr) { tr = []; this.trails.set(p.id, tr); }
      const last = tr[tr.length - 1];
      if (p.state === 'alive' && (!last || Math.hypot(wrapDelta(last.x - p.x, C.WORLD_W), wrapDelta(last.y - p.y, C.WORLD_H)) > 0.25)) {
        if (last && Math.hypot(wrapDelta(last.x - p.x, C.WORLD_W), wrapDelta(last.y - p.y, C.WORLD_H)) > 2) tr.length = 0;
        tr.push({ x: p.x, y: p.y });
        if (tr.length > 10) tr.shift();
      }
      if (!this.visible(x, y)) continue;
      const me = viewer && p.id === viewer.id;
      const main = p.maze === this.viewMaze;
      if (p.state === 'alive' && tr.length > 1) {
        ctx.strokeStyle = p.color;
        ctx.lineCap = 'round';
        for (let i = 1; i < tr.length; i++) {
          const a = this.sx(tr[i - 1].x), b = this.sy(tr[i - 1].y), c = this.sx(tr[i].x), d = this.sy(tr[i].y);
          if (Math.abs(a - c) > 60 || Math.abs(b - d) > 60) continue;
          ctx.globalAlpha = (i / tr.length) * (me ? 0.35 : 0.2);
          ctx.lineWidth = 6 + (i / tr.length) * 14;
          ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      ctx.save();
      ctx.translate(x, y);
      let alpha = me ? 1 : main ? 0.88 : 0.5;
      if (p.invuln > 0 && Math.sin(this.time * 24) > 0) alpha *= 0.35;
      let scale = 1.6;
      let spin = 0;
      if (p.state === 'dying') {
        const t = 1 - p.timer / C.DEATH_TIME;
        scale *= Math.max(0, 1 - t * 1.2);
        spin = t * Math.PI * 3;
        alpha *= 1 - t;
      }
      ctx.globalAlpha = alpha;
      // daze charge ring
      if (p.dazeCharge > 0) {
        const t = 1 - p.dazeCharge / C.DAZE_CHARGE;
        ctx.strokeStyle = '#7DE3FF';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(0, 0, 20 + t * 40, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, 18, -Math.PI / 2, -Math.PI / 2 + t * Math.PI * 2); ctx.stroke();
      }
      ctx.rotate(spin);
      ctx.scale(scale, scale);
      const color = p.daze > 0 ? '#8A93B8' : p.color;
      ctx.shadowColor = color;
      ctx.shadowBlur = me ? 16 : main ? 8 : 0;
      ctx.fillStyle = color;
      ctx.save();
      ctx.rotate(Math.PI / 4);
      roundRect(ctx, -11, -11, 22, 22, 5);
      ctx.fill();
      ctx.restore();
      ctx.shadowBlur = 0;
      // direction chevron
      const f = p.face >= 0 ? p.face : 1;
      ctx.rotate([Math.PI / 2, Math.PI, -Math.PI / 2, 0][f]);
      ctx.strokeStyle = '#05060B';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(-3, -6); ctx.lineTo(3, 0); ctx.lineTo(-3, 6); ctx.stroke();
      ctx.restore();
      // daze stars
      if (p.daze > 0) {
        ctx.fillStyle = '#E9EDFF';
        for (let k = 0; k < 3; k++) {
          const a = this.time * 5 + (k * Math.PI * 2) / 3;
          ctx.beginPath(); ctx.arc(x + Math.cos(a) * 22, y - 26 + Math.sin(a) * 6, 3, 0, Math.PI * 2); ctx.fill();
        }
      }
      // name tag
      if (p.state === 'alive' && (main || me)) {
        ctx.font = '700 13px "Chakra Petch", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = me ? '#FFD84A' : p.color;
        ctx.globalAlpha = me ? 1 : 0.85;
        ctx.fillText(me ? 'YOU' : p.name, x, y - 30);
        ctx.globalAlpha = 1;
      }
    }
    void dt;
  }

  private drawEffects(dt: number) {
    const ctx = this.ctx;
    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.92;
      p.vy *= 0.92;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const p of this.particles) {
      const x = this.sx(p.x), y = this.sy(p.y);
      if (!this.visible(x, y, 10)) continue;
      ctx.globalAlpha = p.life / p.max;
      ctx.fillStyle = p.color;
      ctx.fillRect(x - p.size / 2, y - p.size / 2, p.size, p.size);
    }
    for (const r of this.rings) r.life -= dt;
    this.rings = this.rings.filter((r) => r.life > 0);
    for (const r of this.rings) {
      const t = 1 - r.life / r.max;
      const x = this.sx(r.x), y = this.sy(r.y);
      if (!this.visible(x, y, 300)) continue;
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, (r.r0 + (r.r1 - r.r0) * t) * TS, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawMazeOverlays(game: Game, viewer: Player | null) {
    const ctx = this.ctx;
    const m = game.mazes[this.viewMaze];
    if (!m) return;
    const px = OX + wrapDelta(m.ox - this.camX, C.WORLD_W) * TS;
    const py = OY + wrapDelta(m.oy - this.camY, C.WORLD_H) * TS;
    // Telegraph incoming Blackout/Frenzy with a flashing border.
    const warn = m.blackoutWarn > 0 ? '#FF3DCB' : m.frenzyWarn > 0 ? '#FF5A36' : m.collapseTimer > 0 ? '#FF4D5E' : null;
    if (warn && Math.sin(this.time * 18) > -0.2) {
      ctx.strokeStyle = warn;
      ctx.lineWidth = 6;
      ctx.shadowColor = warn;
      ctx.shadowBlur = 20;
      ctx.strokeRect(px + 4, py + 4, MAZE_PX_W - 8, MAZE_PX_H - 8);
      ctx.shadowBlur = 0;
    }
    void viewer;
  }

  private drawBlackout(game: Game, viewer: Player | null) {
    if (!viewer || viewer.state === 'out') return;
    const m = game.mazes[game.mazeAt(viewer.x, viewer.y)];
    if (m.blackout <= 0) return;
    const ctx = this.ctx;
    const x = this.sx(viewer.x), y = this.sy(viewer.y);
    const fade = Math.min(1, m.blackout / 0.5, (C.BLACKOUT_TIME - m.blackout) / 0.3 + 0.2);
    const g = ctx.createRadialGradient(x, y, 70, x, y, 190);
    g.addColorStop(0, 'rgba(2,3,8,0)');
    g.addColorStop(1, `rgba(2,3,8,${0.97 * fade})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

