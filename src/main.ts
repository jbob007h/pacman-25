// Browser entry point: wires the simulation to input, rendering, HUD and audio.

import * as C from './config';
import { Game } from './game';
import { Renderer, VIEW_W, VIEW_H } from './render';
import { Hud } from './hud';
import { Audio } from './audio';
import { DOWN, LEFT, RIGHT, UP } from './movement';
import type { GameEvent, Player } from './types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const stage = $('stage');
const renderer = new Renderer($<HTMLCanvasElement>('game'));
const hud = new Hud();
const audio = new Audio();

type Mode = 'start' | 'play' | 'paused' | 'end';
let mode: Mode = 'start';
let game: Game | null = null;
let acc = 0;
let last = performance.now();
let spectateId = -1;
let endShownAt = -1;
let humanOutHandled = false;

// ---------- layout ----------

function fit() {
  const wrap = $('wrap');
  const s = Math.min((wrap.clientWidth || window.innerWidth) / VIEW_W, (wrap.clientHeight || window.innerHeight) / VIEW_H);
  stage.style.transform = `scale(${s})`;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.resize(Math.max(0.5, s * dpr));
}
window.addEventListener('resize', fit);
fit();

// ---------- screens ----------

function show(id: string | null) {
  for (const s of ['screen-start', 'screen-pause', 'screen-end']) $(s).classList.toggle('show', s === id);
}

function loadName(): string {
  try { return localStorage.getItem('maze-royale-name') ?? ''; } catch { return ''; }
}
function saveName(n: string) {
  try { localStorage.setItem('maze-royale-name', n); } catch { /* storage unavailable */ }
}
const nameInput = $<HTMLInputElement>('name');
nameInput.value = loadName();

function startMatch() {
  audio.unlock();
  const name = (nameInput.value.trim().toUpperCase().replace(/[^A-Z0-9 _-]/g, '') || 'ACE').slice(0, 10);
  saveName(name);
  game = new Game({ seed: (Date.now() ^ (Math.random() * 1e9)) >>> 0, human: true, humanName: name });
  acc = 0;
  spectateId = -1;
  endShownAt = -1;
  humanOutHandled = false;
  mode = 'play';
  audio.playing = true;
  show(null);
  nameInput.blur();
}

$('play').addEventListener('click', startMatch);
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') startMatch(); e.stopPropagation(); });
$('resume').addEventListener('click', () => { mode = 'play'; show(null); });
$('quit').addEventListener('click', () => { mode = 'start'; audio.playing = false; show('screen-start'); });
$('again').addEventListener('click', startMatch);
$('spectate').addEventListener('click', () => { mode = 'play'; show(null); });

function pause() {
  if (mode !== 'play' || !game || game.over) return;
  mode = 'paused';
  show('screen-pause');
}
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

function showEnd(g: Game, human: Player, over: boolean) {
  const won = g.winner === human.id;
  $('end-title').textContent = won ? 'VICTORY' : over ? `#${human.placement} PLACE` : 'ELIMINATED';
  const winner = g.winner >= 0 ? g.players[g.winner] : null;
  $('end-sub').textContent = won
    ? 'Last Pac-Man standing out of 25.'
    : over
      ? `${winner ? winner.name + ' won the match. ' : ''}You placed #${human.placement} of ${C.PLAYERS}.`
      : `You placed #${human.placement} of ${C.PLAYERS}. Spectate the rest of the match, or start a new one.`;
  const t = Math.floor(human.state === 'out' && !won ? human.stats.outAt : g.time);
  const cells: [string, string][] = [
    [`${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`, over ? 'MATCH TIME' : 'SURVIVED'],
    [String(human.stats.dots), 'PELLETS'],
    [String(human.stats.ghosts), 'GHOSTS EATEN'],
    [String(human.stats.raidersSent), 'RAIDERS SENT'],
  ];
  $('end-stats').innerHTML = cells.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('');
  $('spectate').style.display = over ? 'none' : '';
  show('screen-end');
}

// ---------- input ----------

const KEYS: Record<string, number> = {
  ArrowUp: UP, KeyW: UP, ArrowLeft: LEFT, KeyA: LEFT, ArrowDown: DOWN, KeyS: DOWN, ArrowRight: RIGHT, KeyD: RIGHT,
};

function human(): Player | null {
  return game && game.humanId >= 0 ? game.players[game.humanId] : null;
}

window.addEventListener('keydown', (e) => {
  if (e.code in KEYS) {
    e.preventDefault();
    const h = human();
    if (mode === 'play' && h && game) game.setDir(h, KEYS[e.code]);
    return;
  }
  if (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
    e.preventDefault();
    if (mode === 'start') { startMatch(); return; }
    const h = human();
    if (mode === 'play' && h && game) game.usePower(h);
    return;
  }
  if (e.code === 'Enter') {
    if (mode === 'start' || mode === 'end') startMatch();
    else if (mode === 'paused') { mode = 'play'; show(null); }
    return;
  }
  if (e.code === 'KeyP' || e.code === 'Escape') {
    if (mode === 'play') pause();
    else if (mode === 'paused') { mode = 'play'; show(null); }
    return;
  }
  if (e.code === 'KeyM') { audio.setMuted(!audio.muted); return; }
  if (e.code === 'Tab' && game && human()?.state === 'out') {
    e.preventDefault();
    const alive = game.players.filter((p) => p.state !== 'out');
    if (alive.length) {
      const i = alive.findIndex((p) => p.id === spectateId);
      spectateId = alive[(i + 1) % alive.length].id;
    }
  }
});

// Touch: swipe anywhere to steer, tap the power-up slot to use it.
let touchStart: { x: number; y: number } | null = null;
window.addEventListener('touchstart', (e) => {
  audio.unlock();
  const t = e.touches[0];
  touchStart = { x: t.clientX, y: t.clientY };
}, { passive: true });
window.addEventListener('touchmove', (e) => {
  if (!touchStart || !game || mode !== 'play') return;
  const t = e.touches[0];
  const dx = t.clientX - touchStart.x, dy = t.clientY - touchStart.y;
  if (Math.hypot(dx, dy) < 24) return;
  const h = human();
  if (h) game.setDir(h, Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? RIGHT : LEFT) : dy > 0 ? DOWN : UP);
  touchStart = { x: t.clientX, y: t.clientY };
}, { passive: true });
$('slot').addEventListener('click', () => { const h = human(); if (game && h && mode === 'play') game.usePower(h); });
$('slot').addEventListener('touchstart', (e) => { e.stopPropagation(); const h = human(); if (game && h && mode === 'play') game.usePower(h); }, { passive: true });

// ---------- sound routing ----------

function playSounds(g: Game, events: GameEvent[], viewer: Player | null) {
  if (!viewer) return;
  const vm = g.mazeAt(viewer.x, viewer.y);
  for (const e of events) {
    const mine = e.player === viewer.id;
    switch (e.kind) {
      case 'dot': if (mine) audio.dot(); break;
      case 'power': if (mine || e.maze === vm) audio.power(); break;
      case 'ghost': if (mine) { audio.ghost(); if (e.target?.length) audio.sent(); } break;
      case 'death': if (mine) audio.death(); break;
      case 'raiders': if (e.target?.includes(vm)) audio.raiders(); break;
      case 'blackout': case 'frenzy': if (e.target?.includes(vm)) audio.warn(); break;
      case 'dazeCharge': if (mine) audio.dazeCharge(); else if (e.maze === vm) audio.warn(); break;
      case 'daze': if (mine || e.maze === vm) audio.zap(); break;
      case 'collapseStart': if (e.maze === vm) audio.warn(); break;
      case 'collapse': audio.collapse(); break;
      case 'airdrop': audio.airdrop(); break;
      case 'pickup': if (mine) audio.pickup(); break;
      case 'fruit': if (mine || e.maze === vm) audio.fruit(); break;
      default: break;
    }
  }
}

// ---------- main loop ----------

function viewerOf(g: Game): Player | null {
  const h = g.humanId >= 0 ? g.players[g.humanId] : null;
  if (h && h.state !== 'out') return h;
  if (g.over && g.winner >= 0) return g.players[g.winner];
  let s = g.players[spectateId];
  if (!s || s.state === 'out') {
    const alive = g.players.filter((p) => p.state !== 'out').sort((a, b) => b.lives - a.lives || b.stats.dots - a.stats.dots);
    s = alive[0] ?? h ?? g.players[0];
    spectateId = s.id;
  }
  return s;
}

function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (game) {
    if (mode === 'play' && !game.over) {
      acc += dt;
      while (acc >= C.TICK) { game.step(C.TICK); acc -= C.TICK; }
    }
    const h = human();
    const viewer = viewerOf(game);
    const events = game.events;
    renderer.onEvents(game, events, viewer);
    hud.onEvents(game, events, h);
    if (mode === 'play') playSounds(game, events, viewer);
    if (h) {
      for (const e of events) {
        if (e.kind === 'out' && e.player === h.id) audio.lose();
        if (e.kind === 'win' && e.player === h.id) audio.win();
      }
    }
    game.events.length = 0;

    // Music intensity follows the tension of the match.
    const alive = game.players.filter((p) => p.state !== 'out').length;
    audio.intensity = (alive <= 18 ? 1 : 0) + (alive <= 8 || game.time >= C.OVERTIME_START ? 1 : 0) + (h && h.state !== 'out' && h.lives === 1 ? 1 : 0);
    audio.tick();

    renderer.render(game, viewer, mode === 'paused' ? 0 : dt);
    hud.update(game, h, viewer, dt);

    if (h && mode === 'play') {
      if (h.state === 'out' && !humanOutHandled && !game.over) {
        humanOutHandled = true;
        const g = game;
        setTimeout(() => { if (game === g && mode === 'play' && !g.over) { mode = 'end'; showEnd(g, h, false); } }, 1200);
      }
    }
    if (h && (mode === 'play' || mode === 'end')) {
      if (game.over && endShownAt < 0) {
        endShownAt = now;
        const g = game;
        setTimeout(() => { if (game === g) { mode = 'end'; audio.playing = false; showEnd(g, h, true); } }, 1800);
      }
    }
  }
  requestAnimationFrame(frame);
}

// Debug/testing hook (read-only access to the running match).
(window as unknown as { __mazeRoyale: object }).__mazeRoyale = { get game() { return game; } };

// Attract mode: a bot-only match runs behind the start screen.
game = new Game({ seed: 12345, human: false });
requestAnimationFrame((t) => { last = t; requestAnimationFrame(frame); });
setInterval(() => {
  if (mode === 'start' && game && game.humanId < 0) {
    if (game.over) game = new Game({ seed: (Math.random() * 1e9) >>> 0, human: false });
    for (let i = 0; i < 2; i++) game.step(C.TICK);
  }
}, 1000 / 30);
