import type { MazeLayout } from './maze';
import type { Mover } from './movement';

export type PowerKind = 'blackout' | 'frenzy' | 'daze';

export interface MazeState {
  idx: number;
  mx: number;
  my: number;
  ox: number; // world tile x of local (0,0)
  oy: number;
  layout: MazeLayout;
  pellets: Uint8Array;
  dotsLeft: number;
  level: number;
  owner: number; // player id whose home this is
  collapsed: boolean;
  collapseTimer: number; // >0 while counting down to collapse
  frightTimer: number;
  frightGen: number;
  mode: 'scatter' | 'chase';
  modeTimer: number;
  frenzy: number;
  frenzyWarn: number;
  blackout: number;
  blackoutWarn: number;
  effectBy: number; // player id who cast the latest blackout/frenzy here
  fruit: boolean;
  raiderCount: number;
}

export type GhostState = 'house' | 'active' | 'eyes' | 'gone';

export interface Ghost extends Mover {
  id: number;
  maze: number;
  kind: number; // 0..3: chaser, ambusher, flanker, shy
  state: GhostState;
  timer: number;
  eatenGen: number;
}

export interface Raider extends Mover {
  id: number;
  maze: number;
  sender: number;
  life: number;
  materialize: number;
  grace: number;
  dead: boolean;
}

export interface BotBrain {
  skill: number; // 0..1
  aggression: number; // 0..1, how much it values raiding other mazes
  useDelay: number; // seconds before using a held power-up
  goalMaze: number; // long-range target maze when nothing nearby, -1 = none
  goalX: number;
  goalY: number;
  goalTimer: number;
  thinkTimer: number;
  lastReverse: number; // game time of the last turnaround (anti-dithering)
}

export interface Player extends Mover {
  id: number;
  name: string;
  color: string;
  human: boolean;
  home: number;
  maze: number;
  face: number; // last non-negative direction (for drawing and ghost targeting)
  lives: number;
  state: 'alive' | 'dying' | 'out';
  timer: number;
  invuln: number;
  daze: number;
  dazeCharge: number;
  charge: number;
  slot: PowerKind | null;
  placement: number;
  stats: { dots: number; ghosts: number; raidersSent: number; fruits: number; powerUps: number; outAt: number };
  bot: BotBrain | null;
}

export interface Airdrop {
  id: number;
  maze: number;
  x: number;
  y: number;
}

export type EventKind =
  | 'dot' | 'power' | 'ghost' | 'death' | 'out' | 'collapseStart' | 'collapse' | 'fruitSpawn' | 'fruit'
  | 'raiders' | 'airdrop' | 'pickup' | 'blackout' | 'frenzy' | 'dazeCharge' | 'daze' | 'overtime' | 'win' | 'respawn' | 'reload';

export interface GameEvent {
  kind: EventKind;
  time: number;
  text?: string;
  color?: string;
  maze?: number;
  x?: number;
  y?: number;
  player?: number;
  target?: number[];
}
