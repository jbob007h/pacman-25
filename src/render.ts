// Canvas renderer. Draws a fixed 1600x900 logical screen: the maze the viewed
// player is in fills the middle, with strips of the 8 surrounding mazes around it.
// The camera snaps (with a short slide) to whichever maze the player is in.
//
// Doors to neighboring mazes are drawn as "gates" in the neighbor's colors with
// chevrons streaming outward; side tunnels (which warp within the same maze) are
// drawn as violet vortex portals, so the two never read as the same thing.

import * as C from './config';
import { P_DOT, P_POWER } from './maze';
import { DX, DY, wrapDelta } from './movement';
import { wallSegments, type Segment } from './walls';
import { mazeName, type Game } from './game';
import type { GameEvent, MazeState, Player, Raider } from './types';

export const VIEW_W = 1600;
export const VIEW_H = 900;
const TS = 30; // tile size in px
const OX = 200; // screen position of the viewed maze's top-left
const OY = 120;
const PAD = 24;
const MAZE_PX_W = C.MW * TS;
const MAZE_PX_H = C.MH * TS;
// Classic color coding by behavior: chaser red, ambusher pink, flanker cyan, shy orange.
const GHOST_COLORS = ['#FF2E3E', '#FFA6E6', '#2EE6FF', '#FFAA3D'];
const FRIGHT_PALETTE: [string, string, string] = ['#1F3BFF', '#6E8BFF', '#2A2FFF'];
const WARP = { core: '#C77DFF', hot: '#F3E3FF', deep: '#7A3DFF' };
const DANGER_PALETTE: [string, string, string] = ['#FF2F4A', '#FF8A3D', '#FF1F3A'];
const PHASE_COLORS = ['#FF3DCB', '#2EE6FF', '#FFFFFF'];
const SLIDE_TIME = 0.2;
const REDUCED_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number }
interface Ring { x: number; y: number; life: number; max: number; color: string; r0: number; r1: number; width: number }
interface Popup { x: number; y: number; text: string; sub?: string; color: string; life: number; max: number; size: number }
interface Star { x: number; y: number; r: number; tw: number; depth: number }

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
  private slideDX = 0;
  private slideDY = 0;
  private viewMaze = -1;
  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private popups: Popup[] = [];
  private trails = new Map<number, { x: number; y: number }[]>();
  private dotPop = new Map<number, number>();
  private levelFlash = new Map<number, number>();
  private portalFlash = new Map<string, number>();
  private mazeCard: { title: string; sub: string; color: string; life: number } | null = null;
  private stars: Star[] = [];
  private shake = 0;
  private goTimer = 0;
  private punch = 0; // brief zoom-in pulse
  /** Recent corner cuts: draw the player sliding diagonally across the corner, plus a skid arc. */
  private cornerFx = new Map<number, { dx: number; dy: number; life: number }>();
  private skids: { x: number; y: number; fromDir: number; toDir: number; life: number; color: string; hot: boolean }[] = [];
  /** Pass-through effects: lightning between player and enemy, RGB afterimages. */
  private phaseFx: { player: number; ex: number; ey: number; color: string; life: number }[] = [];
  private flash = { color: '#FFFFFF', alpha: 0 };
  private nearMiss = 0;
  private frameDt = 0;
  private gameRef: Game | null = null;
  time = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    for (let i = 0; i < 140; i++) {
      this.stars.push({ x: Math.random() * VIEW_W, y: Math.random() * VIEW_H, r: 0.6 + Math.random() * 1.4, tw: Math.random() * 6, depth: 0.15 + Math.random() * 0.5 });
    }
    this.resize(1);
  }

  resize(scale: number) {
    if (scale !== this.scale) this.wallCache.clear();
    this.scale = scale;
    this.canvas.width = Math.round(VIEW_W * scale);
    this.canvas.height = Math.round(VIEW_H * scale);
  }

  private addShake(amount: number) { this.shake = Math.max(this.shake, amount); }
  private addFlash(color: string, alpha: number) { if (alpha >= this.flash.alpha) this.flash = { color, alpha }; }

  /** Feeds simulation events to the visual effects. */
  onEvents(game: Game, events: GameEvent[], viewer: Player | null) {
    const vm = viewer && viewer.state !== 'out' ? game.mazeAt(viewer.x, viewer.y) : this.viewMaze;
    const near = new Set(vm >= 0 ? [vm, ...game.neighborTargets(vm)] : []);
    const mine = (e: GameEvent) => viewer !== null && e.player === viewer.id;
    for (const e of events) {
      switch (e.kind) {
        case 'dot':
          if (mine(e)) this.dotPop.set(e.player!, 1);
          this.burst(e.x!, e.y!, '#F4E9C8', 4, 1.6, 0.3);
          break;
        case 'power':
          this.ring(e.x!, e.y!, '#FFF3D1', 0.6, 0.4, e.maze === vm ? 7 : 3, 4);
          if (e.maze === vm) this.ring(e.x!, e.y!, '#6E8BFF', 0.9, 0.4, 16, 2);
          this.burst(e.x!, e.y!, '#FFF3D1', 18, 6, 0.6);
          if (e.maze === vm) { this.addShake(4); this.addFlash('#6E8BFF', 0.18); }
          if (mine(e)) this.popup(e.x!, e.y!, 'POWER!', '#FFF3D1', 26);
          break;
        case 'ghost': {
          const sent = e.target?.length ?? 0;
          this.ring(e.x!, e.y!, '#FFFFFF', 0.45, 0.3, 3.5, 5);
          this.ring(e.x!, e.y!, e.color ?? '#9AB0FF', 0.7, 0.5, 7, 3);
          this.burst(e.x!, e.y!, '#9AB0FF', 22, 7, 0.7);
          this.burst(e.x!, e.y!, e.color ?? '#FFFFFF', 10, 4, 0.5);
          this.popup(e.x!, e.y!, `×${e.n ?? 1}`, '#FFFFFF', 30 + Math.min(4, e.n ?? 1) * 4, sent ? `${sent} RAIDER${sent > 1 ? 'S' : ''} SENT` : undefined);
          if (e.maze === vm) { this.addShake(5 + (e.n ?? 1)); this.addFlash('#FFFFFF', 0.22); }
          break;
        }
        case 'death':
          this.burst(e.x!, e.y!, e.color ?? '#FFD84A', 36, 9, 1);
          this.ring(e.x!, e.y!, e.color ?? '#fff', 0.8, 0.4, 6, 4);
          if (mine(e)) { this.addShake(16); this.addFlash('#FF2F5A', 0.45); }
          else if (e.maze === vm) this.addShake(4);
          break;
        case 'fruit':
          this.ring(e.x!, e.y!, '#FF4D5E', 0.9, 0.4, 16, 4);
          this.burst(e.x!, e.y!, '#FF8FA0', 30, 7, 0.9);
          this.burst(e.x!, e.y!, '#7CE38B', 10, 4, 0.7);
          this.popup(e.x!, e.y!, 'FRUIT!', '#FF8FA0', 28);
          if (e.maze === vm) { this.addShake(6); this.addFlash('#FF8FA0', 0.2); }
          break;
        case 'levelUp': {
          this.levelFlash.set(e.maze!, 1);
          if (e.maze === vm) {
            const pal = C.LEVEL_PALETTE[e.n ?? 1];
            const m = game.mazes[e.maze];
            this.popup(m.ox + C.MW / 2, m.oy + 3.5, `LEVEL ${e.n}`, pal[1], 48, 'FASTER GHOSTS · SHORTER POWER');
          }
          break;
        }
        case 'pickup': {
          const p = game.players[e.player!];
          const x = e.x ?? p.x, y = e.y ?? p.y;
          this.ring(x, y, '#7DE3FF', 0.6, 0.3, 6, 3);
          this.burst(x, y, '#7DE3FF', 14, 5, 0.6);
          if (mine(e)) this.popup(x, y, String(e.text ?? '').toUpperCase(), '#7DE3FF', 26);
          break;
        }
        case 'airdrop':
          this.ring(e.x!, e.y!, '#7DE3FF', 1.1, 3, 0.4, 3);
          this.burst(e.x!, e.y!, '#7DE3FF', 16, 5, 0.8);
          break;
        case 'raiders':
          if (e.target?.includes(vm)) { this.addShake(4); this.addFlash(e.color ?? '#FF3DCB', 0.14); }
          break;
        case 'daze':
          if (e.maze === vm) { this.addShake(9); this.addFlash('#7DE3FF', 0.3); }
          {
            const p = game.players[e.player!];
            this.ring(p.x, p.y, '#7DE3FF', 0.7, 0.5, 22, 5);
          }
          break;
        case 'corner': {
          const p = game.players[e.player!];
          const fromDir = e.n ?? p.dir;
          const toDir = p.dir;
          const hot = e.text === 'phase';
          const near = e.maze === vm;
          // Sparks spray along the old direction of travel, away from the turn.
          const n = near ? (hot ? 16 : 9) : 4;
          for (let i = 0; i < n; i++) {
            const spread = (Math.random() - 0.5) * 5;
            const sp = 5 + Math.random() * 6;
            const vx = DX[fromDir] * sp - DX[toDir] * sp * 0.45 + (DY[fromDir] !== 0 ? spread : 0) * 0.6;
            const vy = DY[fromDir] * sp - DY[toDir] * sp * 0.45 + (DX[fromDir] !== 0 ? spread : 0) * 0.6;
            const color = hot ? (Math.random() < 0.5 ? '#FFFFFF' : '#7DFFF3') : (Math.random() < 0.6 ? '#FFD84A' : '#FFF3D1');
            this.particles.push({ x: e.x!, y: e.y!, vx, vy, life: 0.3 + Math.random() * 0.2, max: 0.5, color, size: 2 + Math.random() * 2 });
          }
          this.cornerFx.set(p.id, { dx: e.x2! - e.x!, dy: e.y2! - e.y!, life: 0.09 });
          this.skids.push({ x: e.x!, y: e.y!, fromDir, toDir, life: 0.3, color: hot ? '#7DFFF3' : '#FFD84A', hot });
          if (this.skids.length > 30) this.skids.shift();
          break;
        }
        case 'phase': {
          const p = game.players[e.player!];
          this.phaseFx.push({ player: p.id, ex: e.x!, ey: e.y!, color: e.color ?? '#FFFFFF', life: 0.55 });
          this.ring(e.x2!, e.y2!, '#FFFFFF', 0.35, 0.3, 3, 6);
          this.ring(e.x2!, e.y2!, '#2EE6FF', 0.5, 0.4, 5, 3);
          this.ring(e.x2!, e.y2!, '#FF3DCB', 0.6, 0.5, 6.5, 2);
          this.burst(e.x2!, e.y2!, '#7DFFF3', 22, 8, 0.6);
          this.burst(e.x!, e.y!, e.color ?? '#FFFFFF', 18, 6, 0.6);
          this.popup(e.x2!, e.y2!, 'PHASED!', '#7DFFF3', 30);
          if (mine(e)) { this.addShake(7); this.addFlash('#BFFBFF', 0.32); this.punch = 1; }
          else if (e.maze === vm) this.addShake(3);
          break;
        }
        case 'collapseTick':
          if (e.maze === vm) {
            const urgent = (e.n ?? 9) <= 3;
            this.addShake(urgent ? 7 : 3);
            this.addFlash('#FF2F4A', urgent ? 0.28 : 0.14);
          }
          break;
        case 'count':
          if (e.n === 0) { this.goTimer = 0.8; this.addFlash('#FFD84A', 0.25); this.addShake(6); }
          break;
        case 'collapseStart':
          if (e.maze === vm) this.addShake(4);
          break;
        case 'collapse':
          if (e.maze === vm) { this.addShake(18); this.addFlash('#FF4D5E', 0.4); }
          else if (near.has(e.maze!)) this.addShake(8);
          break;
        case 'warp': {
          // Both portal mouths flare.
          this.portalFlash.set(`${Math.round(e.x!)},${Math.round(e.y!)}`, 1);
          this.portalFlash.set(`${Math.round(e.x2!)},${Math.round(e.y2!)}`, 1);
          this.burst(e.x!, e.y!, WARP.core, 14, 5, 0.5);
          this.burst(e.x2!, e.y2!, WARP.hot, 14, 5, 0.5);
          this.ring(e.x2!, e.y2!, WARP.core, 0.5, 0.3, 2.5, 4);
          if (mine(e)) this.addShake(3);
          break;
        }
        case 'door':
          if (mine(e)) {
            const m = game.mazes[e.maze!];
            const owner = m.owner >= 0 ? game.players[m.owner] : null;
            const whose = m.idx === viewer!.home ? 'YOUR HOME' : owner ? `${owner.name}’S HOME` : '';
            this.mazeCard = { title: mazeName(m.idx), sub: `LV ${m.level}${whose ? ' · ' + whose : ''}`, color: C.LEVEL_PALETTE[m.level][1], life: 1.5 };
            const p = game.players[e.player!];
            this.burst(p.x, p.y, p.color, 10, 6, 0.4);
          }
          break;
        default: break;
      }
    }
  }

  private burst(x: number, y: number, color: string, n: number, speed: number, life: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.6);
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life, max: life, color, size: 2 + Math.random() * 2.5 });
    }
    if (this.particles.length > 900) this.particles.splice(0, this.particles.length - 900);
  }

  private ring(x: number, y: number, color: string, life: number, r0: number, r1: number, width = 3) {
    this.rings.push({ x, y, color, life, max: life, r0, r1, width });
  }

  private popup(x: number, y: number, text: string, color: string, size: number, sub?: string) {
    this.popups.push({ x, y, text, sub, color, life: 1.1, max: 1.1, size });
    if (this.popups.length > 30) this.popups.shift();
  }

  // ---------- coordinates ----------

  private sx(x: number) { return OX + (wrapDelta(x - (this.camX + C.MW / 2), C.WORLD_W) + C.MW / 2) * TS + TS / 2; }
  private sy(y: number) { return OY + (wrapDelta(y - (this.camY + C.MH / 2), C.WORLD_H) + C.MH / 2) * TS + TS / 2; }
  private visible(px: number, py: number, m = 60) { return px > -m && px < VIEW_W + m && py > -m && py < VIEW_H + m; }
  private mazePos(m: MazeState) {
    return { px: OX + wrapDelta(m.ox - this.camX, C.WORLD_W) * TS, py: OY + wrapDelta(m.oy - this.camY, C.WORLD_H) * TS };
  }

  // ---------- wall art ----------

  private wallCanvas(game: Game, idx: number, variant: 'normal' | 'fright' | 'danger' = 'normal'): HTMLCanvasElement {
    const m = game.mazes[idx];
    const key = `${idx}:${m.collapsed ? 'x' : variant === 'fright' ? 'f' : variant === 'danger' ? 'd' : m.level}`;
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
      const [c1, c2, c3] = variant === 'fright' ? FRIGHT_PALETTE : variant === 'danger' ? DANGER_PALETTE : C.LEVEL_PALETTE[m.level];
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
    while (this.wallCache.size > 24) this.wallCache.delete(this.wallCache.keys().next().value!);
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
      this.popups = [];
      this.levelFlash.clear();
      this.portalFlash.clear();
      this.mazeCard = null;
      this.layerKey = '';
      this.cornerFx.clear();
      this.skids = [];
      this.phaseFx = [];
      this.viewMaze = -1;
    }
    this.time += dt;
    this.frameDt = dt;
    const ctx = this.ctx;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.fillStyle = '#05060B';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // Camera: snap to the viewed player's maze, with a short slide.
    const target = viewer ? (viewer.state === 'dying' ? this.viewMaze : game.mazeAt(viewer.x, viewer.y)) : 12;
    const tm = game.mazes[target < 0 ? 12 : target];
    if (this.viewMaze !== tm.idx) {
      if (this.viewMaze < 0) { this.camX = tm.ox; this.camY = tm.oy; this.camT = 1; }
      else {
        this.camFromX = this.camX; this.camFromY = this.camY; this.camT = 0;
        this.slideDX = Math.sign(wrapDelta(tm.ox - this.camX, C.WORLD_W));
        this.slideDY = Math.sign(wrapDelta(tm.oy - this.camY, C.WORLD_H));
      }
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

    this.drawStars();

    // Screen shake + near-miss zoom apply to the world, not the HUD.
    this.shake *= Math.exp(-dt * 10);
    if (this.shake < 0.2) this.shake = 0;
    const amp = REDUCED_MOTION ? 0 : this.shake;
    this.punch = Math.max(0, this.punch - dt * 4);
    const zoom = 1 + this.nearMiss * 0.012 + this.punch * 0.03;
    // Only touch the transform when needed: an identity-but-not-quite matrix knocks
    // the big wall bitmaps off the fast pixel-aligned blit path.
    if (amp > 0) ctx.translate(Math.round((Math.random() - 0.5) * amp), Math.round((Math.random() - 0.5) * amp));
    if (zoom > 1) {
      ctx.translate(VIEW_W / 2, VIEW_H / 2);
      ctx.scale(zoom, zoom);
      ctx.translate(-VIEW_W / 2, -VIEW_H / 2);
    }

    this.drawMazes(game);
    this.drawPortals(game);
    this.drawPellets(game);
    this.drawCollapseWarnings(game);
    this.drawSkids(dt);
    this.drawPickups(game);
    this.drawGhosts(game);
    this.drawRaiders(game);
    this.drawPlayers(game, viewer, dt);
    this.drawPhaseFx(game, dt);
    this.drawEffects(dt);
    this.drawMazeOverlays(game);

    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    this.drawSlideStreaks();
    if (this.nearMiss > 0) {
      const g = ctx.createRadialGradient(VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.35, VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.85);
      g.addColorStop(0, 'rgba(255,40,80,0)');
      g.addColorStop(1, `rgba(255,40,80,${0.22 * this.nearMiss})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }
    this.drawBlackout(game, viewer);
    this.drawMazeCard(dt);
    this.drawCountdown(game, viewer, dt);
    if (this.flash.alpha > 0.005) {
      ctx.globalAlpha = this.flash.alpha;
      ctx.fillStyle = this.flash.color;
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      this.flash.alpha *= Math.exp(-dt * 9);
    }
  }

  private drawStars() {
    const ctx = this.ctx;
    ctx.fillStyle = '#9AA6E0';
    for (const s of this.stars) {
      const x = ((s.x - this.camX * TS * s.depth * 0.05) % VIEW_W + VIEW_W) % VIEW_W;
      const y = ((s.y - this.camY * TS * s.depth * 0.05) % VIEW_H + VIEW_H) % VIEW_H;
      ctx.globalAlpha = 0.08 + 0.12 * (0.5 + 0.5 * Math.sin(this.time * 1.5 + s.tw)) * s.depth * 2;
      ctx.fillRect(x - s.r, y - s.r, s.r * 2, s.r * 2);
    }
    ctx.globalAlpha = 1;
  }

  private nineMazes(game: Game): MazeState[] {
    const cm = game.mazes[game.mazeAt(this.camX + C.MW / 2, this.camY + C.MH / 2)];
    const out: MazeState[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        out.push(game.mazes[((cm.mx + dx + C.GRID) % C.GRID) + ((cm.my + dy + C.GRID) % C.GRID) * C.GRID]);
      }
    }
    return out;
  }

  /**
   * Static wall art for the 3x3 neighborhood is composited into one screen-sized
   * layer and reused until something changes (camera, a level, a collapse, a power
   * pellet). Animated cases (fades, flickers, flares) draw directly.
   */
  private layer: HTMLCanvasElement | null = null;
  private layerKey = '';

  private drawMazes(game: Game) {
    const ctx = this.ctx;
    const nine = this.nineMazes(game);
    let animating = this.camT < 1;
    const parts: string[] = [String(this.viewMaze), String(this.scale)];
    for (const m of nine) {
      const fk = this.frightMix(m);
      if ((fk > 0 && fk < 1) || m.collapseTimer > 0 || m.hitstop > 0 || (this.levelFlash.get(m.idx) ?? 0) > 0) animating = true;
      parts.push(`${m.idx}:${m.collapsed ? 'x' : m.level}:${fk >= 1 ? 'f' : 'n'}`);
    }
    if (animating) {
      this.drawWallsTo(ctx, game, nine);
    } else {
      const key = parts.join('|');
      if (!this.layer || key !== this.layerKey) {
        this.layer ??= document.createElement('canvas');
        this.layer.width = this.canvas.width;
        this.layer.height = this.canvas.height;
        const lc = this.layer.getContext('2d')!;
        lc.setTransform(this.scale, 0, 0, this.scale, 0, 0);
        lc.clearRect(0, 0, VIEW_W, VIEW_H);
        this.drawWallsTo(lc, game, nine);
        this.layerKey = key;
      }
      ctx.drawImage(this.layer, 0, 0, VIEW_W, VIEW_H);
    }
    for (const m of nine) {
      if (m.idx !== this.viewMaze || m.collapsed) continue;
      const { px, py } = this.mazePos(m);
      this.drawGates(game, m, px, py);
    }
    for (const [k, v] of this.levelFlash) {
      const nv = v - this.frameDt * 1.6;
      if (nv <= 0) this.levelFlash.delete(k); else this.levelFlash.set(k, nv);
    }
  }

  /** 0 = normal walls, 1 = fully "powered" blue walls; in between while fading or flickering. */
  private frightMix(m: MazeState): number {
    if (m.collapsed || m.frightTimer <= 0) return 0;
    const total = C.FRIGHT_TIME[m.level];
    let fk = Math.min(1, (total - m.frightTimer) / 0.25, m.frightTimer / 0.3);
    if (m.frightTimer < 1.6) fk *= Math.sin(this.time * 16) > 0 ? 1 : 0.25;
    return fk;
  }

  private drawWallsTo(ctx: CanvasRenderingContext2D, game: Game, nine: MazeState[]) {
    for (const m of nine) {
      const { px, py } = this.mazePos(m);
      if (px > VIEW_W || py > VIEW_H || px + MAZE_PX_W < 0 || py + MAZE_PX_H < 0) continue;
      const main = m.idx === this.viewMaze;
      const base = main ? 1 : 0.45;
      const dx = px - PAD, dy = py - PAD, w = MAZE_PX_W + PAD * 2, h = MAZE_PX_H + PAD * 2;
      // Power pellet: walls flood blue, then flicker back as the power runs out.
      const fk = this.frightMix(m);
      if (fk < 1) {
        ctx.globalAlpha = base * (1 - fk);
        ctx.drawImage(this.wallCanvas(game, m.idx), dx, dy, w, h);
      }
      if (fk > 0) {
        ctx.globalAlpha = base * fk;
        ctx.drawImage(this.wallCanvas(game, m.idx, 'fright'), dx, dy, w, h);
      }
      // Collapsing: walls throb red in time with the countdown.
      if (m.collapseTimer > 0) {
        const frac = Math.ceil(m.collapseTimer) - m.collapseTimer; // 0 at each tick
        ctx.globalAlpha = base * (0.55 + 0.45 * (1 - frac));
        ctx.drawImage(this.wallCanvas(game, m.idx, 'danger'), dx, dy, w, h);
      }
      // Level-up / hit-pause flare: brighten the walls additively.
      const lf = this.levelFlash.get(m.idx) ?? 0;
      const hs = m.hitstop > 0 ? m.hitstop / C.HITSTOP : 0;
      const flare = Math.max(lf, hs * 0.6);
      if (flare > 0.01) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = base * flare;
        ctx.drawImage(this.wallCanvas(game, m.idx, fk > 0.5 ? 'fright' : 'normal'), dx, dy, w, h);
        ctx.globalCompositeOperation = 'source-over';
      }
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
    }
    // seams between mazes
    const cm = game.mazes[this.viewMaze] ?? game.mazes[0];
    const { px: sxm, py: sym } = this.mazePos(cm);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    for (const x of [sxm, sxm + MAZE_PX_W]) { ctx.moveTo(x, 0); ctx.lineTo(x, VIEW_H); }
    for (const y of [sym, sym + MAZE_PX_H]) { ctx.moveTo(0, y); ctx.lineTo(VIEW_W, y); }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** Doors to neighboring mazes: a lit threshold in the neighbor's colors, chevrons streaming out, and its name. */
  private drawGates(game: Game, m: MazeState, px: number, py: number) {
    const ctx = this.ctx;
    const neighbor = (d: number) => game.mazes[((m.mx + DX[d] + C.GRID) % C.GRID) + ((m.my + DY[d] + C.GRID) % C.GRID) * C.GRID];
    const doors: [number, number, number][] = [
      [C.DOOR_COLS[0], 0, 0], [C.DOOR_COLS[1], 0, 0],
      [C.DOOR_COLS[0], C.MH - 1, 2], [C.DOOR_COLS[1], C.MH - 1, 2],
      [0, C.SIDE_DOOR_ROW, 1], [C.MW - 1, C.SIDE_DOOR_ROW, 3],
    ];
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const [c, r, d] of doors) {
      const ax = DX[d], ay = DY[d]; // outward direction
      const cx = px + c * TS + TS / 2, cy = py + r * TS + TS / 2;
      // Threshold line sits on the maze boundary, across the 2-tile-wide opening.
      const bx = cx + ax * TS / 2, by = cy + ay * TS / 2;
      const half = TS; // half-width of the opening
      const n = neighbor(d);
      ctx.save();
      if (n.collapsed) {
        // Sealed: hazard-striped barrier.
        ctx.translate(bx, by);
        if (ax !== 0) ctx.rotate(Math.PI / 2);
        ctx.fillStyle = '#2A0B12';
        ctx.fillRect(-half, -5, half * 2, 10);
        ctx.beginPath();
        ctx.rect(-half, -5, half * 2, 10);
        ctx.clip();
        ctx.strokeStyle = '#FF4D5E';
        ctx.lineWidth = 4;
        for (let k = -half - 10; k < half + 10; k += 10) { ctx.beginPath(); ctx.moveTo(k, 6); ctx.lineTo(k + 10, -6); ctx.stroke(); }
        ctx.restore();
        ctx.save();
        ctx.font = '700 11px "Chakra Petch", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#FF7A87';
        ctx.fillText('SEALED', bx + ax * 26, by + ay * 22);
        ctx.restore();
        continue;
      }
      const pal = C.LEVEL_PALETTE[n.level];
      const closing = n.collapseTimer > 0;
      const exit = m.collapseTimer > 0 && !closing; // our maze is collapsing: this is a way out
      const blink = closing && Math.sin(this.time * 12) > 0;
      const col = closing ? (blink ? '#FF4D5E' : '#FFD0D5') : exit ? '#3CF29A' : pal[1];
      // Floor glow fading inward from the threshold.
      const depth = TS * 2.6;
      const g = ctx.createLinearGradient(bx, by, bx - ax * depth, by - ay * depth);
      g.addColorStop(0, hexA(col, 0.38));
      g.addColorStop(1, hexA(col, 0));
      ctx.fillStyle = g;
      if (ax === 0) ctx.fillRect(bx - half + 4, Math.min(by, by - ay * depth), half * 2 - 8, depth);
      else ctx.fillRect(Math.min(bx, bx - ax * depth), by - half + 4, depth, half * 2 - 8);
      // Threshold bar.
      ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.moveTo(bx - ay * (half - 6), by - ax * (half - 6));
      ctx.lineTo(bx + ay * (half - 6), by + ax * (half - 6));
      ctx.globalAlpha = 0.25;
      ctx.lineWidth = 12;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 4;
      ctx.stroke();
      // Chevrons streaming outward through the door.
      for (let k = 0; k < 3; k++) {
        const t = (this.time * 1.4 + k / 3) % 1;
        const off = -TS * 1.6 + t * TS * 2.2;
        const tx = bx + ax * off, ty = by + ay * off;
        ctx.globalAlpha = Math.sin(t * Math.PI) * 0.9;
        ctx.strokeStyle = closing || exit ? col : '#FFFFFF';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(tx - ax * 7 - ay * 9, ty - ay * 7 - ax * 9);
        ctx.lineTo(tx, ty);
        ctx.lineTo(tx - ax * 7 + ay * 9, ty - ay * 7 + ax * 9);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // Destination label just outside the door.
      ctx.font = closing || exit ? '800 15px "Chakra Petch", sans-serif' : '700 12px "Chakra Petch", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = closing ? `${mazeName(n.idx)} CLOSING ${Math.ceil(n.collapseTimer)}` : exit ? `EXIT → ${mazeName(n.idx)}` : `${mazeName(n.idx)} · LV ${n.level}`;
      const tw = ctx.measureText(label).width + 14;
      // Side-door labels sit fully outside the maze edge so the chevrons don't cover them.
      const lx = bx + ax * (ax !== 0 ? tw / 2 + 10 : 0), ly = by + ay * 22;
      const th = closing || exit ? 26 : 20;
      ctx.fillStyle = 'rgba(5,6,11,0.85)';
      roundRect(ctx, lx - tw / 2, ly - th / 2, tw, th, th / 2);
      ctx.fill();
      ctx.strokeStyle = hexA(col, 0.7);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.fillText(label, lx, ly + 1);
      ctx.restore();
    }
  }

  /** Side tunnels: violet vortex portals at both ends of the tunnel row, linked to each other. */
  private drawPortals(game: Game) {
    const ctx = this.ctx;
    for (const m of this.nineMazes(game)) {
      if (m.collapsed) continue;
      const { px, py } = this.mazePos(m);
      const main = m.idx === this.viewMaze;
      const alpha = main ? 1 : 0.4;
      const cy = py + C.TUNNEL_ROW * TS + TS / 2;
      for (const side of [0, 1]) {
        const c = side === 0 ? 0 : C.MW - 1;
        const cx = px + c * TS + TS / 2;
        if (!this.visible(cx, cy, 60)) continue;
        const inward = side === 0 ? 1 : -1;
        const flashKey = `${m.ox + c},${m.oy + C.TUNNEL_ROW}`;
        const fl = this.portalFlash.get(flashKey) ?? 0;
        ctx.save();
        ctx.globalAlpha = alpha;
        // Tube floor glowing violet, fading into the maze.
        const g = ctx.createLinearGradient(cx, cy, cx + inward * TS * 3.2, cy);
        g.addColorStop(0, hexA(WARP.core, 0.35 + fl * 0.4));
        g.addColorStop(1, hexA(WARP.core, 0));
        ctx.fillStyle = g;
        ctx.fillRect(Math.min(cx, cx + inward * TS * 3.2), cy - TS + 5, TS * 3.2, TS * 2 - 10);
        // Membrane at the maze edge: the tunnel does not continue into the neighbor.
        const ex = side === 0 ? px : px + MAZE_PX_W;
        ctx.strokeStyle = WARP.hot;
        ctx.lineWidth = 2;
        ctx.globalAlpha = alpha * (0.5 + 0.3 * Math.sin(this.time * 4));
        ctx.beginPath(); ctx.moveTo(ex, cy - TS + 6); ctx.lineTo(ex, cy + TS - 6); ctx.stroke();
        ctx.globalAlpha = alpha;
        // Vortex.
        ctx.translate(cx, cy);
        const R = 15 + fl * 8;
        const halo = ctx.createRadialGradient(0, 0, R * 0.6, 0, 0, R + 16 + fl * 14);
        halo.addColorStop(0, hexA(WARP.core, 0.55));
        halo.addColorStop(1, hexA(WARP.core, 0));
        ctx.fillStyle = halo;
        ctx.beginPath(); ctx.arc(0, 0, R + 16 + fl * 14, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#12051F';
        ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
        const spin = this.time * (side === 0 ? 3 : -3);
        const arcs: [number, string, number, number][] = [[R, WARP.deep, 3, 1], [R * 0.72, WARP.core, 2.5, -1.6], [R * 0.45, WARP.hot, 2, 2.4]];
        for (const [rad, color, wdt, speed] of arcs) {
          ctx.strokeStyle = color;
          ctx.lineWidth = wdt;
          for (let k = 0; k < 2; k++) {
            const a0 = spin * speed + k * Math.PI;
            ctx.beginPath(); ctx.arc(0, 0, rad, a0, a0 + Math.PI * 0.7); ctx.stroke();
          }
        }
        // Motes spiralling in.
        ctx.fillStyle = WARP.hot;
        for (let k = 0; k < 6; k++) {
          const t = (this.time * 0.8 + k / 6) % 1;
          const a = spin * 0.5 + k * 1.7 + t * 4;
          const rr = (1 - t) * (R + 12);
          ctx.globalAlpha = alpha * t;
          ctx.beginPath(); ctx.arc(Math.cos(a) * rr, Math.sin(a) * rr, 1.6, 0, Math.PI * 2); ctx.fill();
        }
        if (!main) { ctx.restore(); continue; }
        ctx.globalAlpha = 0.85;
        ctx.font = '700 10px "Chakra Petch", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = WARP.hot;
        ctx.fillText(side === 0 ? 'WARP ▸' : '◂ WARP', inward * 6, R + 15);
        ctx.restore();
      }
    }
    for (const [k, v] of this.portalFlash) {
      const nv = v - this.frameDt * 2.5;
      if (nv <= 0) this.portalFlash.delete(k); else this.portalFlash.set(k, nv);
    }
  }

  private drawPellets(game: Game) {
    const ctx = this.ctx;
    const pulse = 0.75 + 0.25 * Math.sin(this.time * 6);
    for (const m of this.nineMazes(game)) {
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
      ctx.shadowBlur = 16;
      for (const i of m.layout.powerTiles) {
        if (m.pellets[i] !== P_POWER) continue;
        const x = this.sx(m.ox + (i % C.MW)), y = this.sy(m.oy + Math.floor(i / C.MW));
        if (!this.visible(x, y, 20)) continue;
        ctx.beginPath();
        ctx.arc(x, y, 11 * pulse, 0, Math.PI * 2);
        ctx.fill();
        if (main) {
          ctx.strokeStyle = 'rgba(255,243,209,0.35)';
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(x, y, 14 + 8 * ((this.time * 1.2) % 1), 0, Math.PI * 2); ctx.stroke();
        }
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
  }

  private drawPickups(game: Game) {
    const ctx = this.ctx;
    for (const m of game.mazes) {
      if (!m.fruit) continue;
      const x = this.sx(m.ox + C.FRUIT.x), y = this.sy(m.oy + C.FRUIT.y);
      if (!this.visible(x, y)) continue;
      const bob = Math.sin(this.time * 3) * 3;
      ctx.save();
      ctx.translate(x, y + bob);
      // halo
      ctx.strokeStyle = 'rgba(255,77,94,0.4)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 2, 22 + 4 * Math.sin(this.time * 4), 0, Math.PI * 2); ctx.stroke();
      ctx.shadowColor = '#FF4D5E';
      ctx.shadowBlur = 18;
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
      // beam of light from above
      const beam = ctx.createLinearGradient(x, y - 120, x, y);
      beam.addColorStop(0, 'rgba(125,227,255,0)');
      beam.addColorStop(1, 'rgba(125,227,255,0.22)');
      ctx.fillStyle = beam;
      ctx.fillRect(x - 12, y - 120, 24, 120);
      ctx.translate(x, y + Math.sin(this.time * 3) * 2);
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
      const x = this.sx(g.x);
      let y = this.sy(g.y);
      if (!this.visible(x, y)) continue;
      const main = g.maze === this.viewMaze;
      const eyes = g.state === 'eyes' || g.state === 'entering';
      // Ghosts still in or leaving the house turn blue too if a power pellet is active.
      const fright = game.isFrightened(g) ||
        ((g.state === 'house' || g.state === 'leaving') && m.frightTimer > 0 && g.eatenGen !== m.frightGen);
      ctx.save();
      if (g.state === 'house') y += Math.sin(this.time * 5 + g.kind) * 4;
      ctx.translate(x, y);
      ctx.globalAlpha = main ? 1 : 0.55;
      if (fright) ctx.rotate(Math.sin(this.time * 14 + g.id) * 0.12);
      // Stretch slightly along the direction of travel; squash while crawling out.
      const crawl = g.state === 'leaving' ? 1 + 0.06 * Math.sin(this.time * 18) : 1;
      ctx.scale(1.9 * crawl, 1.9 / crawl);
      if (!eyes) {
        let fill = GHOST_COLORS[g.kind % 4];
        if (fright) fill = m.frightTimer < 1.6 && Math.sin(this.time * 16) > 0 ? '#E8ECFF' : '#2340FF';
        else if (m.frenzy > 0) fill = Math.sin(this.time * 12) > 0 ? '#FFF1C2' : GHOST_COLORS[g.kind % 4]; // white-hot flicker
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
        if (g.emerge > 0 && main) {
          // freshly out: a fading outline so players notice it's still slow
          ctx.strokeStyle = `rgba(255,255,255,${0.6 * g.emerge / C.GHOST_EMERGE_TIME})`;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (fright) {
        ctx.strokeStyle = '#E9EDFF';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-7, -2); ctx.lineTo(-3.5, -5); ctx.lineTo(0, -2); ctx.lineTo(3.5, -5); ctx.lineTo(7, -2);
        ctx.stroke();
      } else {
        ctx.strokeStyle = eyes ? '#E9EDFF' : '#05060B';
        ctx.lineWidth = 3;
        if (eyes) { ctx.shadowColor = '#E9EDFF'; ctx.shadowBlur = 8; }
        const lx = g.dir >= 0 ? DX[g.dir] * 2 : 0, ly = g.dir >= 0 ? DY[g.dir] * 1.5 : 0;
        ctx.beginPath();
        ctx.moveTo(-6 + lx, -3 + ly); ctx.lineTo(6 + lx, -3 + ly);
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
      ctx.restore();
      if (eyes && main && Math.random() < 0.5) {
        this.particles.push({ x: g.x, y: g.y, vx: 0, vy: 0, life: 0.25, max: 0.25, color: '#9AB0FF', size: 3 });
      }
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
      ctx.arc(0, 0, 44 - t * 18, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      // crackle sparks converging
      if (main && Math.random() < 0.6) {
        const a = Math.random() * Math.PI * 2;
        this.particles.push({ x: r.x + Math.cos(a) * 1.4, y: r.y + Math.sin(a) * 1.4, vx: -Math.cos(a) * 3, vy: -Math.sin(a) * 3, life: 0.3, max: 0.3, color: sender.color, size: 2.5 });
      }
      alpha *= 0.25 + 0.4 * t;
    }
    if (r.life < 2 && Math.sin(this.time * 25) > 0) alpha *= 0.4;
    ctx.globalAlpha = alpha;
    ctx.rotate(frozen ? 0 : this.time * 2);
    const pulse = frozen ? 1 : 1 + 0.06 * Math.sin(this.time * 10 + r.id);
    ctx.scale(1.75 * pulse, 1.75 * pulse);
    ctx.beginPath();
    for (let k = 0; k < 16; k++) {
      const rad = k % 2 === 0 ? 14 : 6;
      const a = (k * 22.5 - 90) * Math.PI / 180;
      if (k === 0) ctx.moveTo(rad * Math.cos(a), rad * Math.sin(a)); else ctx.lineTo(rad * Math.cos(a), rad * Math.sin(a));
    }
    ctx.closePath();
    const thawing = frozen && m.frightTimer < 1.6 && Math.sin(this.time * 16) > 0;
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
      let x = this.sx(p.x), y = this.sy(p.y);
      const cf = this.cornerFx.get(p.id);
      if (cf) {
        // Ease out of the pre-cut position: reads as sliding diagonally across the corner.
        const k = cf.life / 0.09;
        x += cf.dx * TS * k;
        y += cf.dy * TS * k;
        cf.life -= dt;
        if (cf.life <= 0) this.cornerFx.delete(p.id);
      }
      // trail
      let tr = this.trails.get(p.id);
      if (!tr) { tr = []; this.trails.set(p.id, tr); }
      const last = tr[tr.length - 1];
      if (p.state === 'alive' && (!last || Math.hypot(wrapDelta(last.x - p.x, C.WORLD_W), wrapDelta(last.y - p.y, C.WORLD_H)) > 0.25)) {
        if (last && Math.hypot(wrapDelta(last.x - p.x, C.WORLD_W), wrapDelta(last.y - p.y, C.WORLD_H)) > 2) tr.length = 0;
        tr.push({ x: p.x, y: p.y });
        if (tr.length > 10) tr.shift();
      }
      const pop = this.dotPop.get(p.id) ?? 0;
      if (pop > 0) this.dotPop.set(p.id, Math.max(0, pop - dt * 8));
      if (!this.visible(x, y)) continue;
      const me = viewer && p.id === viewer.id;
      const main = p.maze === this.viewMaze;
      const powered = main && game.mazes[p.maze].frightTimer > 0;
      if (p.state === 'alive' && tr.length > 1) {
        ctx.strokeStyle = powered ? '#FFFFFF' : p.color;
        ctx.lineCap = 'round';
        for (let i = 1; i < tr.length; i++) {
          const a = this.sx(tr[i - 1].x), b = this.sy(tr[i - 1].y), c = this.sx(tr[i].x), d = this.sy(tr[i].y);
          if (Math.abs(a - c) > 60 || Math.abs(b - d) > 60) continue;
          ctx.globalAlpha = (i / tr.length) * (me ? 0.38 : 0.2);
          ctx.lineWidth = 6 + (i / tr.length) * 16;
          ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      ctx.save();
      ctx.translate(x, y);
      let alpha = me ? 1 : main ? 0.88 : 0.5;
      if (p.invuln > 0 && Math.sin(this.time * 24) > 0) alpha *= 0.35;
      let scale = 1.6 * (1 + pop * 0.16);
      // Chomp: a pulse once per tile travelled.
      if (p.state === 'alive' && p.daze <= 0) scale *= 1 + 0.06 * Math.sin((p.x + p.y) * Math.PI * 2);
      let spin = 0;
      if (p.state === 'dying') {
        const t = 1 - p.timer / C.DEATH_TIME;
        scale *= Math.max(0, 1 - t * 1.2);
        spin = t * Math.PI * 3;
        alpha *= 1 - t;
      }
      ctx.globalAlpha = alpha;
      if (p.dazeCharge > 0) {
        const t = 1 - p.dazeCharge / C.DAZE_CHARGE;
        ctx.strokeStyle = '#7DE3FF';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(0, 0, 20 + t * 40, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, 18, -Math.PI / 2, -Math.PI / 2 + t * Math.PI * 2); ctx.stroke();
      }
      if (powered && p.state === 'alive') {
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 0, 22 + 3 * Math.sin(this.time * 12), 0, Math.PI * 2); ctx.stroke();
      }
      ctx.rotate(spin);
      ctx.scale(scale, scale);
      if (p.phase > 0 || this.phaseFx.some((f) => f.player === p.id)) {
        // Phasing: chromatic split copies behind the body.
        ctx.globalCompositeOperation = 'lighter';
        const j = 2.5 + Math.sin(this.time * 40) * 1.2;
        for (let k = 0; k < 2; k++) {
          ctx.save();
          ctx.translate(k === 0 ? -j : j, k === 0 ? j * 0.4 : -j * 0.4);
          ctx.rotate(Math.PI / 4);
          ctx.globalAlpha = alpha * 0.7;
          ctx.fillStyle = PHASE_COLORS[k];
          roundRect(ctx, -11, -11, 22, 22, 5);
          ctx.fill();
          ctx.restore();
        }
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = alpha * 0.85;
      }
      const color = p.daze > 0 ? '#8A93B8' : p.phase > 0 ? '#E9FFFE' : p.color;
      ctx.shadowColor = color;
      ctx.shadowBlur = me ? 16 : main ? 8 : 0;
      ctx.fillStyle = color;
      ctx.save();
      ctx.rotate(Math.PI / 4);
      roundRect(ctx, -11, -11, 22, 22, 5);
      ctx.fill();
      ctx.restore();
      ctx.shadowBlur = 0;
      const f = p.face >= 0 ? p.face : 1;
      ctx.rotate([Math.PI / 2, Math.PI, -Math.PI / 2, 0][f]);
      ctx.strokeStyle = '#05060B';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(-3, -6); ctx.lineTo(3, 0); ctx.lineTo(-3, 6); ctx.stroke();
      ctx.restore();
      if (p.daze > 0) {
        ctx.fillStyle = '#E9EDFF';
        for (let k = 0; k < 3; k++) {
          const a = this.time * 5 + (k * Math.PI * 2) / 3;
          ctx.beginPath(); ctx.arc(x + Math.cos(a) * 22, y - 26 + Math.sin(a) * 6, 3, 0, Math.PI * 2); ctx.fill();
        }
      }
      if (p.state === 'alive' && (main || me)) {
        ctx.font = '700 13px "Chakra Petch", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = me ? '#FFD84A' : p.color;
        ctx.globalAlpha = me ? 1 : 0.85;
        ctx.fillText(me ? 'YOU' : p.name, x, y - 30);
        ctx.globalAlpha = 1;
      }
    }
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
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      const x = this.sx(p.x), y = this.sy(p.y);
      if (!this.visible(x, y, 10)) continue;
      ctx.globalAlpha = p.life / p.max;
      ctx.fillStyle = p.color;
      ctx.fillRect(x - p.size / 2, y - p.size / 2, p.size, p.size);
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const r of this.rings) r.life -= dt;
    this.rings = this.rings.filter((r) => r.life > 0);
    for (const r of this.rings) {
      const t = 1 - r.life / r.max;
      const x = this.sx(r.x), y = this.sy(r.y);
      if (!this.visible(x, y, 500)) continue;
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.width * (1 - t * 0.6);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0, (r.r0 + (r.r1 - r.r0) * (1 - Math.pow(1 - t, 3))) * TS), 0, Math.PI * 2);
      ctx.stroke();
    }
    // Floating text.
    for (const p of this.popups) p.life -= dt;
    this.popups = this.popups.filter((p) => p.life > 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of this.popups) {
      const t = 1 - p.life / p.max;
      const x = this.sx(p.x), y = this.sy(p.y) - 26 - t * 34;
      if (!this.visible(x, y, 200)) continue;
      const pop = t < 0.15 ? 0.6 + (t / 0.15) * 0.5 : 1.1 - Math.min(0.1, (t - 0.15));
      ctx.globalAlpha = t > 0.7 ? (1 - t) / 0.3 : 1;
      ctx.font = `800 ${Math.round(p.size * pop)}px "Orbitron", sans-serif`;
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(5,6,11,0.85)';
      ctx.strokeText(p.text, x, y);
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 16;
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, x, y);
      ctx.shadowBlur = 0;
      if (p.sub) {
        ctx.font = '700 13px "Chakra Petch", sans-serif';
        ctx.lineWidth = 4;
        ctx.strokeText(p.sub, x, y + p.size * 0.75);
        ctx.fillStyle = '#E9EDFF';
        ctx.fillText(p.sub, x, y + p.size * 0.75);
      }
    }
    ctx.textBaseline = 'alphabetic';
    ctx.globalAlpha = 1;
  }

  private drawMazeOverlays(game: Game) {
    const ctx = this.ctx;
    const m = game.mazes[this.viewMaze];
    if (!m) return;
    const { px, py } = this.mazePos(m);
    // Telegraph incoming Blackout/Frenzy/collapse with a flashing border.
    const warn = m.blackoutWarn > 0 ? '#FF3DCB' : m.frenzyWarn > 0 ? '#FF5A36' : null;
    if (warn && Math.sin(this.time * 18) > -0.2) {
      ctx.strokeStyle = warn;
      ctx.lineWidth = 6;
      ctx.shadowColor = warn;
      ctx.shadowBlur = 20;
      ctx.strokeRect(px + 4, py + 4, MAZE_PX_W - 8, MAZE_PX_H - 8);
      ctx.shadowBlur = 0;
    }
    // Frenzy: a red heat haze around the maze edge.
    if (m.frenzy > 0) {
      const g = ctx.createRadialGradient(px + MAZE_PX_W / 2, py + MAZE_PX_H / 2, MAZE_PX_H * 0.45, px + MAZE_PX_W / 2, py + MAZE_PX_H / 2, MAZE_PX_W * 0.62);
      g.addColorStop(0, 'rgba(255,60,40,0)');
      g.addColorStop(1, `rgba(255,60,40,${0.12 + 0.06 * Math.sin(this.time * 8)})`);
      ctx.fillStyle = g;
      ctx.fillRect(px, py, MAZE_PX_W, MAZE_PX_H);
    }
  }

  /** Corner skids: a quick bright arc hugging the inside of the turn. */
  private drawSkids(dt: number) {
    const ctx = this.ctx;
    for (const s of this.skids) s.life -= dt;
    this.skids = this.skids.filter((s) => s.life > 0);
    ctx.lineCap = 'round';
    for (const s of this.skids) {
      const x = this.sx(s.x), y = this.sy(s.y);
      if (!this.visible(x, y)) continue;
      // Arc from "coming in" (opposite of fromDir) to "going out" (toDir), centered on the inside corner.
      const icx = x - DX[s.fromDir] * 12 + DX[s.toDir] * 12;
      const icy = y - DY[s.fromDir] * 12 + DY[s.toDir] * 12;
      const a0 = Math.atan2(-DY[s.toDir], -DX[s.toDir]);
      const a1 = Math.atan2(DY[s.fromDir], DX[s.fromDir]);
      let delta = a1 - a0;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      ctx.globalAlpha = (s.life / 0.3) * (s.hot ? 1 : 0.7);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.hot ? 4 : 3;
      ctx.beginPath();
      ctx.arc(icx, icy, 12, a0, a0 + delta, delta < 0);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** Lightning between a phasing player and the enemy it slipped through. */
  private drawPhaseFx(game: Game, dt: number) {
    const ctx = this.ctx;
    for (const f of this.phaseFx) f.life -= dt;
    this.phaseFx = this.phaseFx.filter((f) => f.life > 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const f of this.phaseFx) {
      const p = game.players[f.player];
      const ax = this.sx(p.x), ay = this.sy(p.y), bx = this.sx(f.ex), by = this.sy(f.ey);
      if (!this.visible(ax, ay, 200)) continue;
      const t = f.life / 0.55;
      for (const [color, width] of [[f.color, 5], ['#7DFFF3', 2.5], ['#FFFFFF', 1.2]] as [string, number][]) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.globalAlpha = t;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        const segs = 7;
        for (let i = 1; i < segs; i++) {
          const u = i / segs;
          const jx = (Math.random() - 0.5) * 22, jy = (Math.random() - 0.5) * 22;
          ctx.lineTo(ax + (bx - ax) * u + jx, ay + (by - ay) * u + jy);
        }
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
      // An afterimage left where the enemy was.
      ctx.globalAlpha = t * 0.6;
      ctx.strokeStyle = f.color;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(bx, by, 26 + (1 - t) * 30, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  /** Collapsing mazes: throbbing red tint, hazard border and a huge countdown, impossible to miss. */
  private drawCollapseWarnings(game: Game) {
    const ctx = this.ctx;
    for (const m of this.nineMazes(game)) {
      if (m.collapsed || m.collapseTimer <= 0) continue;
      const { px, py } = this.mazePos(m);
      const x0 = Math.max(px, 0), y0 = Math.max(py, 0);
      const x1 = Math.min(px + MAZE_PX_W, VIEW_W), y1 = Math.min(py + MAZE_PX_H, VIEW_H);
      if (x1 <= x0 || y1 <= y0) continue;
      const main = m.idx === this.viewMaze;
      const n = Math.ceil(m.collapseTimer);
      const frac = n - m.collapseTimer; // 0 right at each tick, rising to 1
      const pulse = 1 - frac;
      const urgent = n <= 3;
      ctx.save();
      ctx.beginPath();
      ctx.rect(px, py, MAZE_PX_W, MAZE_PX_H);
      ctx.clip();
      // Red wash that throbs on every second.
      ctx.fillStyle = `rgba(255,30,60,${(main ? 0.06 : 0.12) + (urgent ? 0.16 : 0.09) * pulse})`;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      // Crawling hazard stripes around the inside edge.
      ctx.lineWidth = main ? 12 : 10;
      ctx.setLineDash([18, 18]);
      ctx.lineDashOffset = -this.time * 60;
      ctx.strokeStyle = '#FF2F4A';
      ctx.strokeRect(px + 6, py + 6, MAZE_PX_W - 12, MAZE_PX_H - 12);
      ctx.lineDashOffset = -this.time * 60 + 18;
      ctx.strokeStyle = '#FFD84A';
      ctx.strokeRect(px + 6, py + 6, MAZE_PX_W - 12, MAZE_PX_H - 12);
      ctx.setLineDash([]);
      // The countdown itself: huge behind the play in this maze, clamped into view for neighbors.
      const cx = main ? px + MAZE_PX_W / 2 : Math.min(Math.max(px + MAZE_PX_W / 2, x0 + 70), x1 - 70);
      const cy = main ? py + MAZE_PX_H / 2 : Math.min(Math.max(py + MAZE_PX_H / 2, y0 + 50), y1 - 50);
      const size = main ? 300 : Math.min(110, (y1 - y0) * 0.75, (x1 - x0) * 0.6);
      ctx.translate(cx, cy);
      const sc = 1 + 0.18 * pulse * pulse;
      ctx.scale(sc, sc);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `800 ${Math.round(size)}px "Orbitron", sans-serif`;
      ctx.globalAlpha = main ? 0.22 + 0.4 * pulse : 0.75;
      ctx.fillStyle = urgent ? '#FF2F4A' : '#FF6A5A';
      ctx.fillText(String(n), 0, size * 0.04);
      if (main) {
        ctx.globalAlpha = 0.5 + 0.4 * pulse;
        ctx.font = '800 30px "Orbitron", sans-serif';
        ctx.fillStyle = '#FFE0E4';
        ctx.fillText('COLLAPSING — GET OUT', 0, size * 0.62);
      } else if (size >= 60) {
        ctx.globalAlpha = 0.85;
        ctx.font = '800 13px "Chakra Petch", sans-serif';
        ctx.fillStyle = '#FFE0E4';
        ctx.fillText('COLLAPSING', 0, size * 0.62);
      }
      ctx.restore();
    }
  }

  private drawSlideStreaks() {
    if (this.camT >= 1) return;
    const ctx = this.ctx;
    const k = 1 - this.camT;
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    for (let i = 0; i < 22; i++) {
      const seed = (i * 97.13) % 1;
      const along = ((this.time * 3 + seed) % 1);
      ctx.globalAlpha = 0.18 * k;
      ctx.beginPath();
      if (this.slideDX !== 0) {
        const y = (i / 22) * VIEW_H + 12;
        const x = VIEW_W * along;
        ctx.moveTo(x, y); ctx.lineTo(x - this.slideDX * 160 * k, y);
      } else {
        const x = (i / 22) * VIEW_W + 20;
        const y = VIEW_H * along;
        ctx.moveTo(x, y); ctx.lineTo(x, y - this.slideDY * 110 * k);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** "3, 2, 1, GO!" over the start of a match, with a ring showing where you are. */
  private drawCountdown(game: Game, viewer: Player | null, dt: number) {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (game.countdown > 0) {
      const n = Math.ceil(game.countdown);
      const frac = n - game.countdown; // 0 -> 1 through each second
      const ease = 1 - Math.pow(1 - Math.min(1, frac * 4), 3);
      const scale = 1.7 - 0.7 * ease;
      // dim the world a little so the number reads
      ctx.fillStyle = 'rgba(3,4,9,0.35)';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      if (viewer) {
        const x = this.sx(viewer.x), y = this.sy(viewer.y);
        const r = 34 + 10 * Math.sin(this.time * 6);
        ctx.strokeStyle = '#FFD84A';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
        ctx.font = '700 15px "Chakra Petch", sans-serif';
        ctx.fillStyle = '#FFD84A';
        ctx.fillText(`YOU · HOME ${mazeName(viewer.home)}`, x, y + r + 18);
      }
      ctx.save();
      ctx.translate(VIEW_W / 2, 270);
      ctx.scale(scale, scale);
      ctx.globalAlpha = frac > 0.75 ? 1 - (frac - 0.75) / 0.25 * 0.6 : 1;
      ctx.font = '800 150px "Orbitron", sans-serif';
      ctx.lineWidth = 10;
      ctx.strokeStyle = 'rgba(5,6,11,0.85)';
      ctx.strokeText(String(n), 0, 0);
      ctx.shadowColor = '#FFD84A';
      ctx.shadowBlur = 30;
      ctx.fillStyle = '#FFD84A';
      ctx.fillText(String(n), 0, 0);
      ctx.restore();
      ctx.font = '700 18px "Chakra Petch", sans-serif';
      ctx.fillStyle = '#E9EDFF';
      ctx.fillText('GET READY · LAST ONE STANDING WINS', VIEW_W / 2, 375);
    } else if (this.goTimer > 0) {
      this.goTimer = Math.max(0, this.goTimer - dt);
      const t = 1 - this.goTimer / 0.8;
      ctx.save();
      ctx.translate(VIEW_W / 2, 270);
      ctx.scale(1 + t * 0.8, 1 + t * 0.8);
      ctx.globalAlpha = 1 - t;
      ctx.font = '800 150px "Orbitron", sans-serif';
      ctx.lineWidth = 10;
      ctx.strokeStyle = 'rgba(5,6,11,0.85)';
      ctx.strokeText('GO!', 0, 0);
      ctx.shadowColor = '#3CF29A';
      ctx.shadowBlur = 30;
      ctx.fillStyle = '#3CF29A';
      ctx.fillText('GO!', 0, 0);
      ctx.restore();
    }
    ctx.textBaseline = 'alphabetic';
    ctx.globalAlpha = 1;
  }

  private drawMazeCard(dt: number) {
    const card = this.mazeCard;
    if (!card) return;
    card.life -= dt;
    if (card.life <= 0) { this.mazeCard = null; return; }
    const ctx = this.ctx;
    const t = 1 - card.life / 1.5;
    ctx.globalAlpha = t < 0.12 ? t / 0.12 : card.life < 0.4 ? card.life / 0.4 : 1;
    const y = 214 - (t < 0.12 ? (1 - t / 0.12) * 12 : 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 64px "Orbitron", sans-serif';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(5,6,11,0.8)';
    ctx.strokeText(card.title, VIEW_W / 2, y);
    ctx.shadowColor = card.color;
    ctx.shadowBlur = 24;
    ctx.fillStyle = card.color;
    ctx.fillText(card.title, VIEW_W / 2, y);
    ctx.shadowBlur = 0;
    ctx.font = '700 16px "Chakra Petch", sans-serif';
    ctx.lineWidth = 4;
    ctx.strokeText(card.sub, VIEW_W / 2, y + 46);
    ctx.fillStyle = '#E9EDFF';
    ctx.fillText(card.sub, VIEW_W / 2, y + 46);
    ctx.textBaseline = 'alphabetic';
    ctx.globalAlpha = 1;
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

/** '#RRGGBB' + alpha -> rgba(). */
function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
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

