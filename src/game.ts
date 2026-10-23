// Authoritative game simulation. Runs at a fixed 60 Hz tick and has no DOM
// dependencies, so the same code runs in the browser and in headless tests
// (and is the piece that would move to the server in the multiplayer build).

import * as C from './config';
import { generateMaze, isWalkableCode, P_DOT, P_POWER, T_OPEN, T_WALL } from './maze';
import { DX, DY, LEFT, RIGHT, dist2, move, opposite, wrapDelta, wrapX, wrapY } from './movement';
import { Rng } from './rng';
import type { Airdrop, EventKind, GameEvent, Ghost, MazeState, Player, PowerKind, Raider } from './types';
import { chooseGhostDir, chooseRaiderDir } from './ghosts';
import { botDecide, botUpdate, makeBrain } from './bots';

export const mazeName = (idx: number) => 'ABCDE'[idx % C.GRID] + (Math.floor(idx / C.GRID) + 1);

export interface GameOptions {
  seed: number;
  human: boolean;
  humanName?: string;
  countdown?: number; // seconds of "3, 2, 1, GO" before play starts
}

export class Game {
  readonly rng: Rng;
  readonly seed: number;
  mazes: MazeState[] = [];
  players: Player[] = [];
  ghosts: Ghost[] = [];
  raiders: Raider[] = [];
  airdrops: Airdrop[] = [];
  events: GameEvent[] = []; // drained by the renderer/audio each frame
  feed: GameEvent[] = []; // recent notable events for the HUD
  time = 0;
  /** Seconds left in the pre-match countdown; nothing moves until it reaches 0. */
  countdown = 0;
  over = false;
  winner = -1;
  humanId = -1;
  private airdropTimer = C.AIRDROP_EVERY;
  private overtimeTimer = C.OVERTIME_EVERY;
  private nextId = 1;
  /** Players currently in each maze, rebuilt every tick. */
  inMaze: Player[][] = [];
  // Scratch buffers for BFS (shared by bots and raider spawning).
  readonly bfsStamp = new Int32Array(C.WORLD_W * C.WORLD_H);
  readonly bfsDist = new Int16Array(C.WORLD_W * C.WORLD_H);
  readonly bfsFirst = new Int8Array(C.WORLD_W * C.WORLD_H);
  bfsGen = 0;

  constructor(opts: GameOptions) {
    this.seed = opts.seed;
    this.countdown = opts.countdown ?? 0;
    this.rng = new Rng(opts.seed);
    for (let i = 0; i < C.GRID * C.GRID; i++) {
      const layout = generateMaze(this.rng);
      const mx = i % C.GRID, my = Math.floor(i / C.GRID);
      this.mazes.push({
        idx: i, mx, my, ox: mx * C.MW, oy: my * C.MH, layout,
        pellets: layout.pellets.slice(), dotsLeft: layout.dotCount, level: 1, owner: -1,
        collapsed: false, collapseTimer: 0, frightTimer: 0, frightGen: 0, hitstop: 0, combo: 0,
        mode: 'scatter', modeTimer: C.SCATTER_TIME, frenzy: 0, frenzyWarn: 0, blackout: 0, blackoutWarn: 0,
        effectBy: -1, fruit: false, raiderCount: 0,
      });
      this.inMaze.push([]);
    }
    const homes = this.rng.shuffle([...Array(C.PLAYERS).keys()]);
    const names = this.rng.shuffle([...C.BOT_NAMES]);
    for (let i = 0; i < C.PLAYERS; i++) {
      const human = opts.human && i === 0;
      const home = homes[i];
      const p: Player = {
        id: i, name: human ? (opts.humanName ?? 'YOU') : names[(i - (opts.human ? 1 : 0)) % names.length],
        color: C.PLAYER_COLORS[i % C.PLAYER_COLORS.length], human, home, maze: home,
        x: 0, y: 0, dir: LEFT, next: LEFT, face: LEFT, lives: C.LIVES, state: 'alive', timer: 0,
        invuln: 0, phase: 0, phaseCd: 0, lastPhased: -1, daze: 0, dazeCharge: 0, charge: 0, slot: null, placement: 0,
        stats: { dots: 0, ghosts: 0, raidersSent: 0, fruits: 0, powerUps: 0, outAt: 0 },
        bot: human ? null : makeBrain(this.rng),
      };
      if (human) this.humanId = i;
      this.mazes[home].owner = i;
      this.placeAtSpawn(p);
      p.invuln = 1.5;
      this.players.push(p);
    }
    for (const m of this.mazes) {
      for (let k = 0; k < 4; k++) {
        const g: Ghost = { id: this.nextId++, maze: m.idx, kind: k, x: 0, y: 0, dir: LEFT, next: -1, state: 'house', timer: 0, eatenGen: -1, emerge: 0 };
        this.ghosts.push(g);
      }
      this.resetGhosts(m.idx, false);
    }
  }

  // ---------- helpers ----------

  emit(kind: EventKind, e: Omit<GameEvent, 'kind' | 'time'> = {}, notable = false) {
    const ev: GameEvent = { kind, time: this.time, ...e };
    this.events.push(ev);
    if (notable) {
      this.feed.push(ev);
      if (this.feed.length > 40) this.feed.shift();
    }
  }

  mazeAt(tx: number, ty: number): number {
    const x = wrapX(Math.round(tx)), y = wrapY(Math.round(ty));
    return Math.floor(x / C.MW) + Math.floor(y / C.MH) * C.GRID;
  }

  tileIndex(tx: number, ty: number): { m: MazeState; i: number; lx: number; ly: number } {
    const x = wrapX(Math.round(tx)), y = wrapY(Math.round(ty));
    const m = this.mazes[Math.floor(x / C.MW) + Math.floor(y / C.MH) * C.GRID];
    const lx = x % C.MW, ly = y % C.MH;
    return { m, i: ly * C.MW + lx, lx, ly };
  }

  tileCode(tx: number, ty: number): number {
    const { m, i } = this.tileIndex(tx, ty);
    return m.collapsed ? T_WALL : m.layout.tiles[i];
  }

  pacCanEnter = (tx: number, ty: number) => isWalkableCode(this.tileCode(tx, ty));

  pacSpeed(level: number) {
    return C.PAC_SPEED_BASE + C.PAC_SPEED_PER_LEVEL * (level - 1);
  }

  alivePlayers(): Player[] {
    return this.players.filter((p) => p.state !== 'out');
  }

  isFrightened(g: Ghost): boolean {
    const m = this.mazes[g.maze];
    return g.state === 'active' && m.frightTimer > 0 && g.eatenGen !== m.frightGen;
  }

  raiderHarmful(r: Raider): boolean {
    return !r.dead && r.materialize <= 0 && r.grace <= 0 && this.mazes[r.maze].frightTimer <= 0;
  }

  /** Next open maze in each of the 4 directions (wrapping, skipping collapsed ones), deduped, never `from`. */
  neighborTargets(from: number): number[] {
    const m = this.mazes[from];
    const out: number[] = [];
    for (let d = 0; d < 4; d++) {
      for (let k = 1; k < C.GRID; k++) {
        const nx = (m.mx + DX[d] * k + C.GRID * 4) % C.GRID;
        const ny = (m.my + DY[d] * k + C.GRID * 4) % C.GRID;
        const idx = nx + ny * C.GRID;
        if (idx === from) break;
        if (!this.mazes[idx].collapsed) {
          if (!out.includes(idx)) out.push(idx);
          break;
        }
      }
    }
    return out;
  }

  private placeAtSpawn(p: Player) {
    const m = this.mazes[p.home];
    p.x = m.ox + C.SPAWN.x;
    p.y = m.oy + C.SPAWN.y;
    p.dir = LEFT;
    p.next = LEFT;
    p.face = LEFT;
    p.maze = p.home;
  }

  private houseSlot(g: Ghost) {
    const m = this.mazes[g.maze];
    g.x = m.ox + 17.4 + (g.kind % 4) * 1.4;
    g.y = m.oy + C.HOUSE_CENTER.y;
  }

  private resetGhosts(maze: number, quick: boolean) {
    for (const g of this.ghosts) {
      if (g.maze !== maze || g.state === 'gone') continue;
      g.state = 'house';
      g.timer = C.GHOST_RELEASE[g.kind] + (quick ? C.RESPAWN_RELEASE_DELAY : 0);
      g.eatenGen = this.mazes[maze].frightGen;
      this.houseSlot(g);
    }
  }

  /**
   * Turns every roaming ghost in a maze around on the spot (power pellet, mode switch).
   * The queued turn has to flip too, or the movement code reads it as a request to
   * reverse back and the turnaround is undone on the next frame.
   */
  private reverseGhosts(maze: number) {
    for (const g of this.ghosts) {
      if (g.maze !== maze || g.state !== 'active' || g.dir < 0) continue;
      g.dir = opposite(g.dir);
      g.next = g.dir;
    }
  }

  /** Moves a ghost in a straight line toward (tx, ty) in local maze coords. Returns the distance left over. */
  private glide(g: Ghost, tx: number, ty: number, dist: number): number {
    const m = this.mazes[g.maze];
    const dx = m.ox + tx - g.x, dy = m.oy + ty - g.y;
    const d = Math.abs(dx) + Math.abs(dy);
    if (d <= dist) { g.x = m.ox + tx; g.y = m.oy + ty; return dist - d; }
    if (Math.abs(dx) > 1e-6) g.x += Math.sign(dx) * Math.min(dist, Math.abs(dx));
    else g.y += Math.sign(dy) * dist;
    return 0;
  }

  /** Ghost crawling out of the house: to the middle, up through the gate, then a half step onto the exit tile. */
  private updateLeaving(g: Ghost, dt: number) {
    const m = this.mazes[g.maze];
    const exitX = g.kind % 2 === 0 ? C.HOUSE_EXIT.x : C.HOUSE_EXIT.x + 1;
    let dist = this.pacSpeed(m.level) * C.GHOST_LEAVE_FACTOR * dt;
    const lx = g.x - m.ox, ly = g.y - m.oy;
    if (ly > C.HOUSE_EXIT.y + 1e-6) {
      if (Math.abs(lx - C.HOUSE_CENTER.x) > 1e-6) dist = this.glide(g, C.HOUSE_CENTER.x, ly, dist);
      if (dist > 0) dist = this.glide(g, C.HOUSE_CENTER.x, C.HOUSE_EXIT.y, dist);
    }
    if (dist <= 0) return;
    // Wait at the gate rather than stepping out onto a Pac-Man.
    const ex = m.ox + exitX, ey = m.oy + C.HOUSE_EXIT.y;
    if (this.inMaze[g.maze].some((p) => dist2(p.x, p.y, ex, ey) < 1.5 * 1.5)) return;
    dist = this.glide(g, exitX, C.HOUSE_EXIT.y, dist);
    if (Math.abs(g.x - ex) < 1e-6) {
      g.state = 'active';
      g.dir = g.kind % 2 === 0 ? LEFT : RIGHT;
      g.next = -1;
      g.emerge = C.GHOST_EMERGE_TIME;
    }
  }

  /** Eaten ghost's eyes sinking back into the house. */
  private updateEntering(g: Ghost, dt: number) {
    const m = this.mazes[g.maze];
    let dist = this.pacSpeed(m.level) * C.GHOST_EYES_FACTOR * 0.5 * dt;
    if (g.y - m.oy < C.HOUSE_CENTER.y - 1e-6) {
      dist = this.glide(g, C.HOUSE_CENTER.x, g.y - m.oy, dist);
      if (dist > 0) dist = this.glide(g, C.HOUSE_CENTER.x, C.HOUSE_CENTER.y, dist);
    }
    if (dist <= 0) return;
    const slotX = 17.4 + g.kind % 4 * 1.4;
    dist = this.glide(g, slotX, C.HOUSE_CENTER.y, dist);
    if (Math.abs(g.x - (m.ox + slotX)) < 1e-6) {
      g.state = 'house';
      g.timer = C.EATEN_REENTER;
    }
  }

  // ---------- player actions ----------

  setDir(p: Player, d: number) {
    if (p.state !== 'alive') return;
    p.next = d;
  }

  usePower(p: Player) {
    if (p.state !== 'alive' || !p.slot || p.dazeCharge > 0) return;
    const kind = p.slot;
    p.slot = null;
    p.stats.powerUps++;
    if (kind === 'daze') {
      p.dazeCharge = C.DAZE_CHARGE;
      this.emit('dazeCharge', { player: p.id, maze: p.maze, color: p.color, text: `${p.name} is charging DAZE` }, true);
      return;
    }
    const targets = this.neighborTargets(p.maze);
    for (const t of targets) {
      const m = this.mazes[t];
      if (kind === 'blackout') m.blackoutWarn = C.POWERUP_WARN;
      else m.frenzyWarn = C.POWERUP_WARN;
      m.effectBy = p.id;
    }
    const label = kind === 'blackout' ? 'BLACKOUT' : 'FRENZY';
    this.emit(kind, { player: p.id, maze: p.maze, target: targets, color: p.color, text: `${p.name} cast ${label} on ${targets.map(mazeName).join(' ')}` }, true);
  }

  // ---------- simulation ----------

  step(dt: number) {
    if (this.over) return;
    if (this.countdown > 0) {
      const before = Math.ceil(this.countdown);
      this.countdown = Math.max(0, this.countdown - dt);
      const after = Math.ceil(this.countdown);
      if (after !== before) this.emit('count', { n: after });
      return;
    }
    this.time += dt;

    for (const list of this.inMaze) list.length = 0;
    for (const p of this.players) {
      if (p.state === 'out') continue;
      p.maze = this.mazeAt(p.x, p.y);
      if (p.state === 'alive') this.inMaze[p.maze].push(p);
    }

    this.updateMazes(dt);
    this.updatePlayers(dt);
    this.updateGhosts(dt);
    this.updateRaiders(dt);
    this.collide();
    this.updateWorld(dt);
    this.checkWin();
  }

  private updateMazes(dt: number) {
    for (const m of this.mazes) {
      if (m.collapsed) continue;
      if (m.hitstop > 0) { m.hitstop = Math.max(0, m.hitstop - dt); continue; }
      if (m.collapseTimer > 0) {
        const before = Math.ceil(m.collapseTimer);
        m.collapseTimer -= dt;
        const after = Math.ceil(m.collapseTimer);
        if (after !== before && after > 0) this.emit('collapseTick', { maze: m.idx, n: after });
        if (m.collapseTimer <= 0) this.collapse(m);
        if (m.collapsed) continue;
      }
      if (m.frightTimer > 0) {
        m.frightTimer -= dt;
        if (m.frightTimer <= 0) {
          m.frightTimer = 0;
          for (const r of this.raiders) if (r.maze === m.idx && !r.dead) r.grace = C.RAIDER_THAW_GRACE;
        }
      } else {
        m.modeTimer -= dt;
        if (m.modeTimer <= 0) {
          m.mode = m.mode === 'scatter' ? 'chase' : 'scatter';
          m.modeTimer = m.mode === 'scatter' ? C.SCATTER_TIME : C.CHASE_TIME;
          this.reverseGhosts(m.idx);
        }
      }
      if (m.blackoutWarn > 0) { m.blackoutWarn -= dt; if (m.blackoutWarn <= 0) { m.blackoutWarn = 0; m.blackout = C.BLACKOUT_TIME; } }
      else if (m.blackout > 0) m.blackout = Math.max(0, m.blackout - dt);
      if (m.frenzyWarn > 0) { m.frenzyWarn -= dt; if (m.frenzyWarn <= 0) { m.frenzyWarn = 0; m.frenzy = C.FRENZY_TIME; } }
      else if (m.frenzy > 0) m.frenzy = Math.max(0, m.frenzy - dt);
    }
  }

  private updatePlayers(dt: number) {
    for (const p of this.players) {
      if (p.state === 'out') continue;
      if (p.state === 'dying') {
        p.timer -= dt;
        if (p.timer <= 0) this.afterDeath(p);
        continue;
      }
      if (this.mazes[p.maze].hitstop > 0) continue;
      if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);
      if (p.phase > 0) { p.phase = Math.max(0, p.phase - dt); if (p.phase === 0) p.lastPhased = -1; }
      if (p.phaseCd > 0) p.phaseCd = Math.max(0, p.phaseCd - dt);
      if (p.dazeCharge > 0) {
        p.dazeCharge -= dt;
        if (p.dazeCharge <= 0) this.fireDaze(p);
      }
      if (p.bot) botUpdate(this, p, dt);
      if (p.daze > 0) {
        p.daze = Math.max(0, p.daze - dt);
        continue;
      }
      const level = this.mazes[p.maze].level;
      const ox = p.x, oy = p.y, oMaze = p.maze;
      move(p, this.pacSpeed(level) * dt, {
        canEnter: this.pacCanEnter,
        tunnel: true,
        atCenter: p.bot ? () => botDecide(this, p) : undefined,
        cornerCut: C.CORNER_CUT,
        onCorner: (cut, fx, fy, fdir) => this.onCorner(p, cut, fx, fy, fdir),
      });
      if (p.dir >= 0) p.face = p.dir;
      p.maze = this.mazeAt(p.x, p.y);
      if (Math.abs(wrapDelta(p.x - ox, C.WORLD_W)) > 2) {
        this.emit('warp', { player: p.id, maze: p.maze, x: Math.round(ox), y: Math.round(oy), x2: p.x, y2: p.y });
      } else if (p.maze !== oMaze) {
        this.emit('door', { player: p.id, maze: p.maze, n: oMaze, x: p.x, y: p.y });
      }
      this.eatAt(p);
      if (p.slot === null && p.charge >= C.CHARGE_FULL) {
        p.slot = this.rng.weighted<PowerKind>(['blackout', 'frenzy', 'daze'], [40, 40, 20]);
        p.charge = 0;
        this.emit('pickup', { player: p.id, text: p.slot, color: p.color });
      }
    }
  }

  private eatAt(p: Player) {
    const { m, i } = this.tileIndex(p.x, p.y);
    if (m.collapsed) return;
    const pel = m.pellets[i];
    if (pel === P_DOT) {
      m.pellets[i] = 0;
      m.dotsLeft--;
      p.stats.dots++;
      p.charge = Math.min(C.CHARGE_FULL, p.charge + (m.idx === p.home ? C.CHARGE_HOME : C.CHARGE_AWAY));
      this.emit('dot', { player: p.id, maze: m.idx, x: Math.round(p.x), y: Math.round(p.y) });
      if (m.dotsLeft <= 0 && !m.fruit) {
        m.fruit = true;
        this.emit('fruitSpawn', { maze: m.idx, text: `${mazeName(m.idx)} cleared — fruit appeared` }, true);
      }
    } else if (pel === P_POWER) {
      m.pellets[i] = 0;
      m.frightTimer = C.FRIGHT_TIME[m.level];
      m.frightGen++;
      m.combo = 0;
      this.reverseGhosts(m.idx);
      this.emit('power', { player: p.id, maze: m.idx, x: Math.round(p.x), y: Math.round(p.y) });
    }
    if (m.fruit && dist2(p.x, p.y, m.ox + C.FRUIT.x, m.oy + C.FRUIT.y) < 0.8 * 0.8) this.eatFruit(p, m);
    for (let k = this.airdrops.length - 1; k >= 0; k--) {
      const a = this.airdrops[k];
      if (p.slot === null && a.maze === m.idx && dist2(p.x, p.y, a.x, a.y) < 0.8 * 0.8) {
        p.slot = this.rng.pick<PowerKind>(['blackout', 'frenzy', 'daze']);
        this.airdrops.splice(k, 1);
        this.emit('pickup', { player: p.id, text: p.slot, color: p.color, maze: m.idx, x: a.x, y: a.y });
      }
    }
  }

  private eatFruit(p: Player, m: MazeState) {
    m.fruit = false;
    m.pellets.set(m.layout.pellets);
    m.dotsLeft = m.layout.dotCount;
    const before = m.level;
    m.level = Math.min(C.MAX_LEVEL, m.level + 1);
    if (m.level !== before) this.emit('levelUp', { maze: m.idx, n: m.level });
    p.stats.fruits++;
    for (const r of this.raiders) if (r.maze === m.idx) r.dead = true;
    let text = `${p.name} ate the fruit in ${mazeName(m.idx)} — Lv ${m.level}`;
    if (m.owner !== p.id && m.owner >= 0 && this.players[m.owner].state !== 'out') {
      const home = this.mazes[p.home];
      if (!home.collapsed) {
        for (const i of home.layout.powerTiles) home.pellets[i] = P_POWER;
        text = `${p.name} raided ${this.players[m.owner].name}'s fruit — power pellets reloaded`;
        this.emit('reload', { player: p.id, maze: home.idx });
      }
    }
    this.emit('fruit', { player: p.id, maze: m.idx, x: m.ox + C.FRUIT.x, y: m.oy + C.FRUIT.y, text, color: p.color }, true);
  }

  private fireDaze(p: Player) {
    p.dazeCharge = 0;
    if (p.state !== 'alive') return;
    const victims: string[] = [];
    for (const q of this.inMaze[p.maze]) {
      if (q === p || q.invuln > 0 || q.state !== 'alive') continue;
      q.daze = C.DAZE_TIME;
      victims.push(q.name);
    }
    this.emit('daze', { player: p.id, maze: p.maze, color: p.color, text: victims.length ? `${p.name} dazed ${victims.join(', ')}` : `${p.name}'s DAZE hit nobody` }, true);
  }

  /** Ghost chase speed relative to a Pac-Man in the same maze (ignores fright and tunnels). */
  ghostChaseRatio(g: Ghost): number {
    const m = this.mazes[g.maze];
    let r = C.GHOST_SPEED_FACTOR[m.level];
    if (m.frenzy > 0) r *= C.FRENZY_FACTOR;
    if (g.kind === 0 && m.dotsLeft <= C.ELROY_PELLETS[m.level]) r *= C.ELROY_FACTOR;
    return r;
  }

  private ghostSpeed(g: Ghost): number {
    const m = this.mazes[g.maze];
    const base = this.pacSpeed(m.level);
    if (g.state === 'eyes') return base * C.GHOST_EYES_FACTOR;
    let s = base * C.GHOST_SPEED_FACTOR[m.level];
    if (this.isFrightened(g)) s = base * C.GHOST_FRIGHT_FACTOR;
    else {
      if (m.frenzy > 0) s *= C.FRENZY_FACTOR;
      if (g.kind === 0 && m.dotsLeft <= C.ELROY_PELLETS[m.level]) s *= C.ELROY_FACTOR;
    }
    if (g.emerge > 0) {
      const t = 1 - g.emerge / C.GHOST_EMERGE_TIME;
      s *= C.GHOST_EMERGE_FACTOR + (1 - C.GHOST_EMERGE_FACTOR) * t;
    }
    const ly = Math.round(g.y) - m.oy, lx = Math.round(g.x) - m.ox;
    if (ly === C.TUNNEL_ROW && (lx <= 2 || lx >= C.MW - 3)) s *= C.GHOST_TUNNEL_FACTOR;
    return s;
  }

  private updateGhosts(dt: number) {
    for (const g of this.ghosts) {
      if (g.state === 'gone') continue;
      const m = this.mazes[g.maze];
      if (m.hitstop > 0) continue;
      if (g.state === 'house') {
        g.timer -= dt;
        if (g.timer <= 0) g.state = 'leaving';
        continue;
      }
      if (g.state === 'leaving') { this.updateLeaving(g, dt); continue; }
      if (g.state === 'entering') { this.updateEntering(g, dt); continue; }
      if (g.emerge > 0) g.emerge = Math.max(0, g.emerge - dt);
      if (g.state === 'eyes') {
        // Safety net: eyes should always find the way home, but never let one wander forever.
        g.timer += dt;
        if (g.timer > 12) {
          g.x = m.ox + C.HOUSE_EXIT.x;
          g.y = m.oy + C.HOUSE_EXIT.y;
          g.state = 'entering';
          g.dir = -1;
          g.next = -1;
          continue;
        }
      }
      const canEnter = (tx: number, ty: number) => this.mazeAt(tx, ty) === g.maze && isWalkableCode(this.tileCode(tx, ty));
      move(g, this.ghostSpeed(g) * dt, {
        canEnter,
        tunnel: true,
        atCenter: () => {
          if (g.state === 'eyes' && Math.round(g.x) === m.ox + C.HOUSE_EXIT.x && Math.round(g.y) === m.oy + C.HOUSE_EXIT.y) {
            g.state = 'entering';
            g.dir = -1;
            g.next = -1;
            return;
          }
          chooseGhostDir(this, g, canEnter);
        },
      });
    }
  }

  private updateRaiders(dt: number) {
    for (const r of this.raiders) {
      if (r.dead) continue;
      const m = this.mazes[r.maze];
      if (m.hitstop > 0) continue;
      r.life -= dt;
      if (r.life <= 0 || m.collapsed) { r.dead = true; continue; }
      if (r.materialize > 0) { r.materialize -= dt; continue; }
      if (m.frightTimer > 0) continue; // frozen
      if (r.grace > 0) r.grace -= dt;
      const canEnter = (tx: number, ty: number) => {
        if (this.mazeAt(tx, ty) !== r.maze) return false;
        const { lx, ly } = this.tileIndex(tx, ty);
        if (lx === 0 || ly === 0 || lx === C.MW - 1 || ly === C.MH - 1) return false;
        return this.tileCode(tx, ty) === T_OPEN;
      };
      move(r, C.PAC_SPEED_BASE * C.RAIDER_SPEED_FACTOR * dt, { canEnter, atCenter: () => chooseRaiderDir(this, r, canEnter) });
    }
    if (this.raiders.length > 64) this.raiders = this.raiders.filter((r) => !r.dead);
    for (const m of this.mazes) m.raiderCount = 0;
    for (const r of this.raiders) if (!r.dead) this.mazes[r.maze].raiderCount++;
  }

  private collide() {
    const R2 = C.COLLIDE_DIST * C.COLLIDE_DIST;
    for (const p of this.players) {
      if (p.state !== 'alive' || this.mazes[p.maze].hitstop > 0) continue;
      for (const g of this.ghosts) {
        if (g.maze !== p.maze || g.state !== 'active') continue;
        if (dist2(p.x, p.y, g.x, g.y) > R2) continue;
        if (this.isFrightened(g)) this.eatGhost(p, g);
        else if (p.phase > 0) this.phaseThrough(p, g.id, g.x, g.y, 'ghost', g.kind);
        else if (p.invuln <= 0) { this.kill(p, 'ghost'); break; }
      }
      if (p.state !== 'alive' || p.invuln > 0) continue;
      for (const r of this.raiders) {
        if (r.maze !== p.maze || !this.raiderHarmful(r)) continue;
        if (dist2(p.x, p.y, r.x, r.y) <= R2) {
          if (p.phase > 0) { this.phaseThrough(p, r.id, r.x, r.y, 'raider', r.sender); continue; }
          this.kill(p, 'raider', r.sender);
          break;
        }
      }
    }
  }

  /** A turn queued before the corner was taken early: sparks, and maybe a pass-through window. */
  private onCorner(p: Player, cut: number, fx: number, fy: number, fdir: number) {
    const granted = p.phaseCd <= 0;
    if (granted) {
      p.phase = C.PHASE_TIME;
      p.phaseCd = C.PHASE_COOLDOWN;
    }
    this.emit('corner', { player: p.id, maze: p.maze, x: p.x, y: p.y, x2: fx, y2: fy, n: fdir, text: granted ? 'phase' : '', color: p.color });
    void cut;
  }

  /** Passing through an enemy during a cornering window: no death, a freeze-frame and a big effect. */
  private phaseThrough(p: Player, id: number, x: number, y: number, what: 'ghost' | 'raider', ref: number) {
    if (p.lastPhased === id) return;
    p.lastPhased = id;
    // Keep the window open until we're clear of this enemy.
    p.phase = Math.max(p.phase, 0.15);
    const m = this.mazes[p.maze];
    m.hitstop = Math.max(m.hitstop, C.PHASE_HITSTOP);
    const color = what === 'raider' ? this.players[ref].color : ['#FF2E3E', '#FFA6E6', '#2EE6FF', '#FFAA3D'][ref % 4];
    this.emit('phase', { player: p.id, maze: p.maze, x, y, x2: p.x, y2: p.y, color, text: what });
  }

  private eatGhost(p: Player, g: Ghost) {
    const m = this.mazes[g.maze];
    g.state = 'eyes';
    g.timer = 0;
    g.eatenGen = m.frightGen;
    p.stats.ghosts++;
    m.combo++;
    m.hitstop = C.HITSTOP;
    let targets: number[] = [];
    if (p.maze !== p.home) targets = this.sendRaiders(p.maze, p);
    this.emit('ghost', { player: p.id, maze: m.idx, x: g.x, y: g.y, color: p.color, target: targets, n: m.combo });
    if (targets.length) {
      this.emit('raiders', { player: p.id, color: p.color, target: targets, text: `${p.name} sent raiders to ${targets.map(mazeName).join(' ')}` }, true);
    }
  }

  sendRaiders(from: number, sender: Player): number[] {
    const hit: number[] = [];
    for (const t of this.neighborTargets(from)) {
      if (this.inMaze[t].length === 0) continue;
      if (this.spawnRaider(t, sender)) hit.push(t);
    }
    return hit;
  }

  /** Multi-source BFS inside one maze; fills bfsDist for tiles of that maze. Returns the generation stamp. */
  bfsInMaze(maze: number, sources: { x: number; y: number }[], walk: (tx: number, ty: number) => boolean): number {
    const gen = ++this.bfsGen;
    const q: number[] = [];
    for (const s of sources) {
      const x = wrapX(Math.round(s.x)), y = wrapY(Math.round(s.y));
      const k = y * C.WORLD_W + x;
      if (this.bfsStamp[k] === gen) continue;
      this.bfsStamp[k] = gen;
      this.bfsDist[k] = 0;
      q.push(k);
    }
    for (let h = 0; h < q.length; h++) {
      const k = q[h];
      const x = k % C.WORLD_W, y = Math.floor(k / C.WORLD_W);
      for (let d = 0; d < 4; d++) {
        const nx = wrapX(x + DX[d]), ny = wrapY(y + DY[d]);
        const nk = ny * C.WORLD_W + nx;
        if (this.bfsStamp[nk] === gen) continue;
        if (this.mazeAt(nx, ny) !== maze || !walk(nx, ny)) continue;
        this.bfsStamp[nk] = gen;
        this.bfsDist[nk] = this.bfsDist[k] + 1;
        q.push(nk);
      }
    }
    return gen;
  }

  private spawnRaider(maze: number, sender: Player): boolean {
    const m = this.mazes[maze];
    if (m.collapsed || m.raiderCount >= C.MAX_RAIDERS_PER_MAZE) return false;
    const pacs = this.inMaze[maze];
    const occupied = new Set<number>();
    for (const q of pacs) {
      const lx = Math.round(q.x) - m.ox, ly = Math.round(q.y) - m.oy;
      occupied.add((lx < C.MW / 2 ? 0 : 1) + (ly < C.MH / 2 ? 0 : 2));
    }
    const gen = this.bfsInMaze(maze, pacs, this.pacCanEnter);
    const good: number[] = [];
    let far = -1, farD = -1;
    for (const i of m.layout.dotTiles) {
      const lx = i % C.MW, ly = Math.floor(i / C.MW);
      const k = (m.oy + ly) * C.WORLD_W + (m.ox + lx);
      const d = this.bfsStamp[k] === gen ? this.bfsDist[k] : 999;
      if (d > farD) { farD = d; far = i; }
      const quad = (lx < C.MW / 2 ? 0 : 1) + (ly < C.MH / 2 ? 0 : 2);
      if (!occupied.has(quad) && d >= C.RAIDER_MIN_PATH) good.push(i);
    }
    const i = good.length ? this.rng.pick(good) : far;
    if (i < 0) return false;
    const r: Raider = {
      id: this.nextId++, maze, sender: sender.id, x: m.ox + (i % C.MW), y: m.oy + Math.floor(i / C.MW),
      dir: -1, next: -1, life: C.RAIDER_LIFE, materialize: C.RAIDER_MATERIALIZE, grace: 0, dead: false,
    };
    this.raiders.push(r);
    m.raiderCount++;
    sender.stats.raidersSent++;
    return true;
  }

  private kill(p: Player, cause: 'ghost' | 'raider' | 'collapse', by = -1) {
    if (p.state !== 'alive') return;
    p.state = 'dying';
    p.timer = C.DEATH_TIME;
    p.lives--;
    p.daze = 0;
    p.dazeCharge = 0;
    const byText = cause === 'raider' && by >= 0 ? ` by ${this.players[by].name}'s raider` : cause === 'collapse' ? ' in a collapse' : '';
    this.emit('death', { player: p.id, maze: p.maze, x: p.x, y: p.y, color: p.color, text: `${p.name} lost a life${byText}` }, p.human || cause !== 'ghost');
  }

  private afterDeath(p: Player) {
    if (p.lives > 0) {
      p.state = 'alive';
      this.placeAtSpawn(p);
      p.invuln = C.RESPAWN_INVULN;
      for (const r of this.raiders) if (r.maze === p.home) r.dead = true;
      this.resetGhosts(p.home, true);
      this.emit('respawn', { player: p.id, maze: p.home });
      return;
    }
    p.state = 'out';
    p.stats.outAt = this.time;
    p.placement = this.players.filter((q) => q.state !== 'out').length + 1;
    const home = this.mazes[p.home];
    if (!home.collapsed && home.collapseTimer <= 0) home.collapseTimer = C.COLLAPSE_COUNTDOWN;
    this.emit('out', { player: p.id, maze: p.home, color: p.color, text: `${p.name} eliminated (#${p.placement}) — ${mazeName(p.home)} collapsing` }, true);
    this.emit('collapseStart', { maze: p.home });
  }

  private collapse(m: MazeState) {
    m.collapsed = true;
    m.collapseTimer = 0;
    m.fruit = false;
    m.pellets.fill(0);
    m.dotsLeft = 0;
    m.frightTimer = 0;
    m.blackout = m.blackoutWarn = m.frenzy = m.frenzyWarn = 0;
    for (const g of this.ghosts) if (g.maze === m.idx) g.state = 'gone';
    for (const r of this.raiders) if (r.maze === m.idx) r.dead = true;
    this.airdrops = this.airdrops.filter((a) => a.maze !== m.idx);
    for (const p of this.players) {
      if (p.state === 'alive' && this.mazeAt(p.x, p.y) === m.idx) this.kill(p, 'collapse');
    }
    this.emit('collapse', { maze: m.idx, text: `${mazeName(m.idx)} collapsed` }, true);
  }

  private updateWorld(dt: number) {
    this.airdropTimer -= dt;
    if (this.airdropTimer <= 0) {
      this.airdropTimer = C.AIRDROP_EVERY;
      if (this.airdrops.length < C.MAX_AIRDROPS) {
        const open = this.mazes.filter((m) => !m.collapsed);
        if (open.length) {
          const m = this.rng.pick(open);
          const i = this.rng.pick(m.layout.dotTiles);
          const a: Airdrop = { id: this.nextId++, maze: m.idx, x: m.ox + (i % C.MW), y: m.oy + Math.floor(i / C.MW) };
          this.airdrops.push(a);
          this.emit('airdrop', { maze: m.idx, x: a.x, y: a.y, text: `Airdrop landed in ${mazeName(m.idx)}` }, true);
        }
      }
    }
    if (this.time >= C.OVERTIME_START) {
      this.overtimeTimer -= dt;
      if (this.overtimeTimer <= 0) {
        this.overtimeTimer = C.OVERTIME_EVERY;
        let added = false;
        for (const m of this.mazes) {
          if (m.collapsed) continue;
          if (m.level < C.MAX_LEVEL) { m.level++; this.emit('levelUp', { maze: m.idx, n: m.level }); continue; }
          // Already at max level: add another ghost instead, so stalemates can't last.
          const count = this.ghosts.filter((g) => g.maze === m.idx && g.state !== 'gone').length;
          if (count >= C.MAX_GHOSTS_PER_MAZE) continue;
          const g: Ghost = { id: this.nextId++, maze: m.idx, kind: count % 4, x: 0, y: 0, dir: LEFT, next: -1, state: 'house', timer: 1, eatenGen: m.frightGen, emerge: 0 };
          this.houseSlot(g);
          this.ghosts.push(g);
          added = true;
        }
        this.emit('overtime', { text: added ? 'Overtime — an extra ghost joined every maze' : 'Overtime — every maze leveled up' }, true);
      }
    }
  }

  private checkWin() {
    const alive = this.players.filter((p) => p.state !== 'out');
    if (alive.length > 1) return;
    this.over = true;
    let w = alive[0];
    if (!w) {
      // Simultaneous wipe: best stats among the last eliminated wins.
      const last = this.players.filter((p) => p.placement === 2 || p.placement === 1);
      w = last.sort((a, b) => b.stats.dots - a.stats.dots)[0] ?? this.players[0];
    }
    w.placement = 1;
    this.winner = w.id;
    this.emit('win', { player: w.id, color: w.color, text: `${w.name} wins!` }, true);
  }
}
