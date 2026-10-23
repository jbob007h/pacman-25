// Headless match runner used by `npm run sim`: plays bot-only matches at full
// speed and reports how they went, so balance changes can be checked quickly.

import { Game, mazeName } from './game';
import { TICK } from './config';

export interface MatchReport {
  seed: number;
  seconds: number;
  winner: string;
  collapsed: number;
  ghostsEaten: number;
  raidersSent: number;
  fruits: number;
  powerUps: number;
  maxLevel: number;
  timeline: string[];
  ms: number;
}

export function runMatch(seed: number, maxSeconds = 30 * 60): MatchReport {
  const t0 = Date.now();
  const game = new Game({ seed, human: false });
  const timeline: string[] = [];
  let lastMinute = 0;
  while (!game.over && game.time < maxSeconds) {
    game.step(TICK);
    for (const e of game.events) {
      if (e.kind === 'out' || e.kind === 'win' || e.kind === 'overtime') timeline.push(`${fmt(game.time)} ${e.text}`);
    }
    game.events.length = 0;
    if (game.time - lastMinute >= 60) {
      lastMinute = Math.floor(game.time / 60) * 60;
      const alive = game.players.filter((p) => p.state !== 'out').length;
      timeline.push(`${fmt(game.time)} — ${alive} alive`);
    }
  }
  const sum = (f: (p: Game['players'][number]) => number) => game.players.reduce((a, p) => a + f(p), 0);
  return {
    seed,
    seconds: Math.round(game.time),
    winner: game.winner >= 0 ? `${game.players[game.winner].name} (home ${mazeName(game.players[game.winner].home)})` : 'none',
    collapsed: game.mazes.filter((m) => m.collapsed).length,
    ghostsEaten: sum((p) => p.stats.ghosts),
    raidersSent: sum((p) => p.stats.raidersSent),
    fruits: sum((p) => p.stats.fruits),
    powerUps: sum((p) => p.stats.powerUps),
    maxLevel: Math.max(...game.mazes.map((m) => m.level)),
    timeline,
    ms: Date.now() - t0,
  };
}

function fmt(t: number) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
