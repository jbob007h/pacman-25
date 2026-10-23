// Messages between the browser and the game server, and the snapshot format.
//
// The server runs the real game (src/game.ts) at 60 Hz. Each client builds an identical
// "mirror" Game from the same seed and human list, so maze layouts and starting state
// match exactly; the server then streams compact snapshots (30 Hz) that overwrite the
// mirror's moving parts. Only the client's own Pac-Man is predicted locally.

import * as C from '../config';
import type { Game } from '../game';
import type { GameEvent, GhostState, MazeState, PowerKind } from '../types';

export const PROTOCOL = 1;
export const SNAPSHOT_EVERY = 2; // ticks between snapshots (60 Hz / 2 = 30 Hz)
export const MAX_HUMANS = C.PLAYERS;
export const FROZEN = 8; // added to a frame's direction when the client was frozen (hitstop, daze) for it
export const LOBBY_SECONDS = 20; // quick play: wait this long for more players, then bots fill in

// ---------- client -> server ----------
export type ClientMsg =
  | { t: 'hello'; v: number; name: string; token?: string }
  | { t: 'quick' }
  | { t: 'create' }
  | { t: 'join'; code: string }
  | { t: 'start' } // private room host
  | { t: 'leave' }
  | { t: 'in'; f: [seq: number, next: number][] } // steering frames, one per client tick; next + FROZEN when you didn't move
  | { t: 'power' }
  | { t: 'view'; id: number } // spectating this player
  | { t: 'ping'; c: number };

// ---------- server -> client ----------
export interface LobbyInfo {
  t: 'lobby';
  code: string | null; // private room code, null for quick play
  host: boolean;
  names: string[];
  startsIn: number | null; // seconds until quick play starts
  max: number;
}
export interface StartMsg { t: 'start'; seed: number; humans: string[]; you: number; countdown: number; rejoin?: boolean }
export interface EndMsg {
  t: 'end';
  winner: number;
  results: { id: number; placement: number; outAt: number; dots: number; ghosts: number; raidersSent: number }[];
}
export type ServerMsg =
  | { t: 'welcome'; token: string }
  | LobbyInfo
  | StartMsg
  | Snapshot
  | EndMsg
  | { t: 'error'; msg: string }
  | { t: 'pong'; c: number }
  | { t: 'left' };

/** Compact per-tick state. Arrays instead of objects keep it small on the wire. */
export interface Snapshot {
  t: 'snap';
  tick: number;
  time: number;
  cd: number; // countdown seconds left
  over: 0 | 1;
  win: number;
  ack: number; // last steering frame of yours the server has applied
  debt?: number; // ticks you moved on the server ahead of your frames (they were late); those frames only steer
  P: PlayerRow[]; // players near your view, and yourself (full detail)
  Q: FarRow[]; // everyone else (enough for the minimap)
  M: MazeRow[]; // mazes whose state changed since your last snapshot
  G: GhostRow[]; // ghosts near your view
  R: RaiderRow[]; // raiders near your view
  A?: [id: number, maze: number, x: number, y: number][]; // airdrops, when they changed
  PL?: [maze: number, ver: number, pellets: string][]; // full pellet layouts (base64) you don't have yet
  E?: WireEvent[];
}

type PlayerRow = [id: number, x: number, y: number, dir: number, next: number, face: number, st: number, lives: number,
  invuln: number, phase: number, phaseCd: number, daze: number, dazeCharge: number, charge: number, slot: number,
  timer: number, placement: number];
type FarRow = [id: number, x: number, y: number, st: number, lives: number];
type MazeRow = [idx: number, level: number, collapsed: number, collapseTimer: number, frightTimer: number, frightGen: number,
  frenzy: number, frenzyWarn: number, blackout: number, blackoutWarn: number, effectBy: number, fruit: number,
  fruitTimer: number, hitstop: number, dotsLeft: number, owner: number, combo: number, mode: number, raiderCount: number,
  board: number, emptyQuadrant: number];
type GhostRow = [id: number, maze: number, kind: number, x: number, y: number, dir: number, st: number, eatenGen: number,
  emerge: number, timer: number];
type RaiderRow = [id: number, maze: number, sender: number, x: number, y: number, dir: number, life: number,
  materialize: number, grace: number];
export type WireEvent = GameEvent & { f?: 1 };

const PSTATE = ['alive', 'dying', 'out'] as const;
const GSTATE: GhostState[] = ['house', 'leaving', 'active', 'eyes', 'entering', 'gone'];
const SLOTS: PowerKind[] = ['blackout', 'frenzy', 'daze'];
const BOARDS: MazeState['board'][] = ['full', 'quadrant', 'empty'];
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Mazes in the 3x3 block around `maze` (the part of the world a player can see). */
export function neighborhood(maze: number): number[] {
  const mx = maze % C.GRID, my = Math.floor(maze / C.GRID);
  const out: number[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    out.push(((mx + dx + C.GRID) % C.GRID) + ((my + dy + C.GRID) % C.GRID) * C.GRID);
  }
  return out;
}

export function mazeRow(m: MazeState): MazeRow {
  return [m.idx, m.level, m.collapsed ? 1 : 0, r2(m.collapseTimer), r2(m.frightTimer), m.frightGen, r2(m.frenzy), r2(m.frenzyWarn),
    r2(m.blackout), r2(m.blackoutWarn), m.effectBy, m.fruit ? 1 : 0, r2(m.fruitTimer), r3(m.hitstop), m.dotsLeft, m.owner, m.combo,
    m.mode === 'chase' ? 1 : 0, m.raiderCount, BOARDS.indexOf(m.board), m.emptyQuadrant];
}

export function playerRow(game: Game, id: number): PlayerRow {
  const p = game.players[id];
  return [p.id, r3(p.x), r3(p.y), p.dir, p.next, p.face, PSTATE.indexOf(p.state), p.lives, r2(p.invuln), r3(p.phase), r2(p.phaseCd),
    r2(p.daze), r2(p.dazeCharge), Math.round(p.charge), p.slot ? SLOTS.indexOf(p.slot) : -1, r2(p.timer), p.placement];
}

export function farRow(game: Game, id: number): FarRow {
  const p = game.players[id];
  return [p.id, r2(p.x), r2(p.y), PSTATE.indexOf(p.state), p.lives];
}

export function ghostRows(game: Game, mazes: Set<number>): GhostRow[] {
  const out: GhostRow[] = [];
  for (const g of game.ghosts) {
    if (!mazes.has(g.maze) || g.state === 'gone') continue;
    out.push([g.id, g.maze, g.kind, r3(g.x), r3(g.y), g.dir, GSTATE.indexOf(g.state), g.eatenGen, r2(g.emerge), r2(g.timer)]);
  }
  return out;
}

export function raiderRows(game: Game, mazes: Set<number>): RaiderRow[] {
  const out: RaiderRow[] = [];
  for (const r of game.raiders) {
    if (r.dead || !mazes.has(r.maze)) continue;
    out.push([r.id, r.maze, r.sender, r3(r.x), r3(r.y), r.dir, r2(r.life), r2(r.materialize), r2(r.grace)]);
  }
  return out;
}

export function encodePellets(p: Uint8Array): string {
  let s = '';
  for (let i = 0; i < p.length; i++) s += String.fromCharCode(p[i]);
  return btoa(s);
}

export function decodePellets(b64: string, into: Uint8Array) {
  const s = atob(b64);
  for (let i = 0; i < into.length && i < s.length; i++) into[i] = s.charCodeAt(i);
}

// ---------- applying snapshots to a client mirror ----------

export function applyMazeRow(game: Game, row: MazeRow) {
  const m = game.mazes[row[0]];
  m.level = row[1]; m.collapsed = row[2] === 1; m.collapseTimer = row[3]; m.frightTimer = row[4]; m.frightGen = row[5];
  m.frenzy = row[6]; m.frenzyWarn = row[7]; m.blackout = row[8]; m.blackoutWarn = row[9]; m.effectBy = row[10];
  m.fruit = row[11] === 1; m.fruitTimer = row[12]; m.hitstop = row[13]; m.dotsLeft = row[14]; m.owner = row[15];
  m.combo = row[16]; m.mode = row[17] ? 'chase' : 'scatter'; m.raiderCount = row[18]; m.board = BOARDS[row[19]];
  m.emptyQuadrant = row[20];
  if (m.collapsed) m.pellets.fill(0);
}

/** Applies a player's non-positional fields; positions are set by interpolation or prediction. */
export function applyPlayerRow(game: Game, row: PlayerRow) {
  const p = game.players[row[0]];
  p.state = PSTATE[row[6]]; p.lives = row[7]; p.invuln = row[8]; p.phase = row[9]; p.phaseCd = row[10];
  p.daze = row[11]; p.dazeCharge = row[12]; p.charge = row[13]; p.slot = row[14] >= 0 ? SLOTS[row[14]] : null;
  p.timer = row[15]; p.placement = row[16];
}

export function applyFarRow(game: Game, row: FarRow) {
  const p = game.players[row[0]];
  p.state = PSTATE[row[3]]; p.lives = row[4];
}

export function ghostStateOf(code: number): GhostState { return GSTATE[code]; }
