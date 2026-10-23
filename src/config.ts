// All tuning lives here so balance passes don't require touching game logic.

export const GRID = 5; // 5x5 world of mazes, wraps both ways
export const MW = 40; // maze width in tiles
export const MH = 22; // maze height in tiles
export const WORLD_W = GRID * MW;
export const WORLD_H = GRID * MH;
export const PLAYERS = GRID * GRID; // one Pac-Man per maze at the start

// Fixed maze template (shared by every maze so neighbors line up).
export const DOOR_COLS = [9, MW - 1 - 9]; // top/bottom doors
export const SIDE_DOOR_ROW = 7;
export const TUNNEL_ROW = 16;
export const SPAWN = { x: 19.5, y: 13 }; // Pac-Man spawn, below the ghost house
export const FRUIT = { x: 19.5, y: 7 }; // fruit spawn, above the ghost house
export const HOUSE_EXIT = { x: 19, y: 7 }; // tile ghosts step out to
export const HOUSE_CENTER = { x: 19.5, y: 10 };

export const TICK = 1 / 60;

// Speeds in tiles/second.
export const PAC_SPEED_BASE = 10;
export const PAC_SPEED_PER_LEVEL = 0.75;
export const GHOST_SPEED_FACTOR = [0, 0.82, 0.86, 0.9, 0.95, 1.0]; // by maze level
export const GHOST_FRIGHT_FACTOR = 0.55;
export const GHOST_TUNNEL_FACTOR = 0.5;
export const GHOST_EYES_FACTOR = 2.0;
export const FRENZY_FACTOR = 1.1;
export const ELROY_FACTOR = 1.08;
export const ELROY_PELLETS = [0, 20, 30, 40, 50, 60];
export const RAIDER_SPEED_FACTOR = 0.72; // relative to level-1 Pac-Man speed

// Durations in seconds.
export const FRIGHT_TIME = [0, 4, 3.6, 3.2, 2.8, 2.4];
export const SCATTER_TIME = 5;
export const CHASE_TIME = 20;
export const GHOST_RELEASE = [0, 1.5, 4, 7];
export const RESPAWN_RELEASE_DELAY = 2.5; // extra house time after the owner respawns
export const EATEN_REENTER = 1;
export const DEATH_TIME = 1.5;
export const RESPAWN_INVULN = 2;
export const RAIDER_LIFE = 15;
export const RAIDER_MATERIALIZE = 1;
export const RAIDER_THAW_GRACE = 0.5;
export const MAX_RAIDERS_PER_MAZE = 4;
export const RAIDER_MIN_PATH = 10;
export const RAIDER_CHASE_CHANCE = 0.7;
export const COLLAPSE_COUNTDOWN = 10;
export const LIVES = 3;
export const MAX_LEVEL = 5;

// Power-ups.
export const CHARGE_FULL = 240;
export const CHARGE_HOME = 1;
export const CHARGE_AWAY = 2;
export const AIRDROP_EVERY = 30;
export const MAX_AIRDROPS = 2;
export const POWERUP_WARN = 1;
export const BLACKOUT_TIME = 8;
export const FRENZY_TIME = 10;
export const DAZE_TIME = 4;
export const DAZE_CHARGE = 1;

// Late-game pressure: after this, every open maze levels up on an interval.
export const OVERTIME_START = 7 * 60;
export const OVERTIME_EVERY = 40;
export const MAX_GHOSTS_PER_MAZE = 8; // overtime adds ghosts once mazes hit max level

export const COLLIDE_DIST = 0.6; // tiles

// Wall colors by maze level: [start, middle, end] of the neon gradient.
export const LEVEL_PALETTE: Record<number, [string, string, string]> = {
  1: ['#2F6BFF', '#00D8FF', '#8A5CFF'],
  2: ['#12C9B8', '#2F8BFF', '#3CF29A'],
  3: ['#9B4DFF', '#FF4FD8', '#3D7BFF'],
  4: ['#FF3F9A', '#FF8A3D', '#A04DFF'],
  5: ['#FF6A1A', '#FFC93D', '#FF2F5A'],
};

export const PLAYER_COLORS = [
  '#FFD84A', // human
  '#E04FBF', '#D9894A', '#5FD3FF', '#8CF06A', '#B88CFF', '#FF6F7D', '#4FE3B5', '#F5A3FF',
  '#C9D86B', '#7FA6FF', '#FFB36B', '#6BE0E0', '#E8E8F0', '#FF8FC2', '#A3E37A', '#9C9CFF',
  '#FFCF8F', '#62C7A0', '#E37ADE', '#88B7D9', '#D9B36B', '#B4F0D2', '#F07A5A', '#C0A0E0',
];

export const BOT_NAMES = [
  'NOVA', 'VEX', 'KRAIT', 'RIFT', 'ONYX', 'PIXEL', 'ZED', 'LUMEN', 'BYTE', 'ECHO', 'FLUX', 'HALO',
  'JINX', 'KILO', 'MOTH', 'NEON', 'ORBIT', 'PRISM', 'QUARK', 'RUNE', 'SABLE', 'TONIC', 'VOLT', 'WISP', 'AXLE',
];
