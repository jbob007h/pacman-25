// Browser entry point: wires the simulation to input, rendering, HUD and audio, for both
// solo matches (simulated here) and online matches (simulated on the server, mirrored here).

import * as C from './config';
import { Game } from './game';
import { Renderer, VIEW_W, VIEW_H } from './render';
import { Hud } from './hud';
import { Audio } from './audio';
import { DOWN, LEFT, RIGHT, UP } from './movement';
import { BTN, Gamepads, clearPadFocus, navigate, padTarget } from './gamepad';
import { OnlineSession, onlineAvailable, serverUrl } from './net/client';
import type { GameEvent, Player } from './types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const stage = $('stage');
const renderer = new Renderer($<HTMLCanvasElement>('game'));
const hud = new Hud();
const audio = new Audio();
const pads = new Gamepads();

type Mode = 'start' | 'lobby' | 'play' | 'paused' | 'end';
let mode: Mode = 'start';
let game: Game | null = null;
let acc = 0;
let last = performance.now();
let spectateId = -1;
let endShownAt = -1;
let humanOutHandled = false;

// Online play is offered when the page was served by the game server.
const ONLINE = onlineAvailable();
let online: OnlineSession | null = null;
let onlineAction: (() => void) | null = null; // waiting for the connection to open
let lastOnlineKind: 'quick' | 'room' = 'quick';

const isOnlineGame = () => !!online && !!game && game === online.game;

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

const SCREENS = ['screen-start', 'screen-lobby', 'screen-pause', 'screen-end'];
let shown: string | null = 'screen-start';
function show(id: string | null) {
  shown = id;
  for (const s of SCREENS) $(s).classList.toggle('show', s === id);
  clearPadFocus();
}

function loadName(): string {
  try { return localStorage.getItem('maze-royale-name') ?? ''; } catch { return ''; }
}
function saveName(n: string) {
  try { localStorage.setItem('maze-royale-name', n); } catch { /* storage unavailable */ }
}
const nameInput = $<HTMLInputElement>('name');
const codeInput = $<HTMLInputElement>('code');
nameInput.value = loadName();

function playerName(): string {
  const name = (nameInput.value.trim().toUpperCase().replace(/[^A-Z0-9 _-]/g, '') || 'ACE').slice(0, 10);
  saveName(name);
  return name;
}

function status(msg: string, error = false) {
  const el = $('net-status');
  el.textContent = msg;
  el.classList.toggle('ok', !error);
}

/** Shared setup when a match (solo or online) begins. */
function enterMatch(g: Game) {
  game = g;
  acc = 0;
  spectateId = -1;
  endShownAt = -1;
  humanOutHandled = false;
  mode = 'play';
  audio.playing = false; // music kicks in on GO
  if (g.countdown > 0) audio.count(Math.ceil(g.countdown));
  else audio.playing = true;
  show(null);
  nameInput.blur();
  codeInput.blur();
  $('ping-stat').classList.toggle('on', isOnlineGame());
}

function startSolo() {
  audio.unlock();
  if (online) { online.close(); online = null; }
  enterMatch(new Game({ seed: (Date.now() ^ (Math.random() * 1e9)) >>> 0, human: true, humanName: playerName(), countdown: C.COUNTDOWN }));
}

function toMenu(msg = '', error = false) {
  mode = 'start';
  audio.playing = false;
  $('ping-stat').classList.remove('on');
  if (!game || game.humanId >= 0) game = new Game({ seed: (Math.random() * 1e9) >>> 0, human: false });
  show('screen-start');
  status(msg, error);
}

// ---------- online ----------

function withSession(action: () => void) {
  audio.unlock();
  if (!ONLINE) return;
  const name = playerName();
  if (online && online.state !== 'closed' && online.state !== 'connecting') { action(); return; }
  if (online && online.state === 'connecting') { onlineAction = action; return; }
  status('Connecting…');
  const s = new OnlineSession(serverUrl());
  online = s;
  onlineAction = action;
  s.onChange = () => { if (online === s) syncOnline(s); };
  s.onError = (msg) => {
    if (online !== s) return;
    if (mode === 'lobby') { s.leave(); toMenu(msg, true); } else status(msg, true);
  };
  s.connect(name);
}

function syncOnline(s: OnlineSession) {
  switch (s.state) {
    case 'menu':
      if (onlineAction) { const a = onlineAction; onlineAction = null; status(''); a(); }
      else if (mode === 'lobby' || isOnlineGame()) toMenu();
      return;
    case 'lobby':
      mode = 'lobby';
      if (shown !== 'screen-lobby') show('screen-lobby');
      renderLobby(s);
      return;
    case 'playing':
      if (s.game && game !== s.game) enterMatch(s.game);
      return;
    case 'closed': {
      const wasPlaying = mode === 'lobby' || isOnlineGame();
      online = null;
      onlineAction = null;
      if (wasPlaying && !(game?.over)) toMenu('Lost the connection to the server.', true);
      else if (mode === 'start') status("Couldn't reach the game server.", true);
      return;
    }
    default:
      return;
  }
}

function renderLobby(s: OnlineSession) {
  const l = s.lobby;
  if (!l) return;
  const priv = l.code !== null;
  $('lobby-kind').textContent = priv ? 'PRIVATE ROOM · CODE' : 'QUICK PLAY';
  $('lobby-code').textContent = priv ? l.code! : l.startsIn !== null ? String(l.startsIn) : '';
  $('lobby-sub').textContent = priv
    ? l.host ? `Share the code with friends, then start. CPU players fill the empty mazes. (${l.names.length}/${l.max})`
      : `Waiting for the host to start. (${l.names.length}/${l.max})`
    : `Match starts in ${l.startsIn ?? '…'} s. CPU players fill the empty mazes. (${l.names.length}/${l.max})`;
  const me = playerName();
  const cells: string[] = [];
  for (let i = 0; i < l.max; i++) {
    const n = l.names[i];
    cells.push(n ? `<div class="${n === me ? 'me' : ''}">${escapeHtml(n)}</div>` : '<div class="bot">CPU</div>');
  }
  $('lobby-names').innerHTML = cells.join('');
  const start = $<HTMLButtonElement>('lobby-start');
  start.style.display = priv && l.host ? '' : 'none';
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function quickPlay() { lastOnlineKind = 'quick'; withSession(() => online!.quickPlay()); }
function createRoom() { lastOnlineKind = 'room'; withSession(() => online!.createRoom()); }
function joinRoom() {
  const code = codeInput.value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) { status('Room codes are 4 letters.', true); codeInput.focus(); return; }
  lastOnlineKind = 'room';
  withSession(() => online!.joinRoom(code));
}

function leaveOnline() {
  if (online) online.leave();
  toMenu();
}

if (!ONLINE) {
  for (const id of ['quick', 'create', 'join']) $<HTMLButtonElement>(id).disabled = true;
  codeInput.disabled = true;
  status('Online play is available when the game is opened from its server.');
}

// ---------- buttons ----------

$('play').addEventListener('click', startSolo);
$('quick').addEventListener('click', quickPlay);
$('create').addEventListener('click', createRoom);
$('join').addEventListener('click', joinRoom);
$('lobby-start').addEventListener('click', () => online?.startRoom());
$('lobby-leave').addEventListener('click', leaveOnline);
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') startSolo(); e.stopPropagation(); });
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); e.stopPropagation(); });
codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, ''); });
$('resume').addEventListener('click', resume);
$('quit').addEventListener('click', () => { if (isOnlineGame()) leaveOnline(); else toMenu(); });
$('again').addEventListener('click', playAgain);
$('spectate').addEventListener('click', () => { mode = 'play'; show(null); });

function playAgain() {
  if (isOnlineGame()) {
    online!.leave();
    if (lastOnlineKind === 'quick') { toMenu(); quickPlay(); } else toMenu('Create or join a room for the next match.');
    return;
  }
  startSolo();
}

function pause() {
  if (mode !== 'play' || !game || game.over) return;
  mode = 'paused';
  const net = isOnlineGame();
  $('pause-title').textContent = net ? 'MENU' : 'PAUSED';
  $('pause-sub').style.display = net ? '' : 'none';
  $('quit').textContent = net ? 'LEAVE MATCH' : 'NEW MATCH';
  show('screen-pause');
}
function resume() {
  if (mode !== 'paused') return;
  mode = 'play';
  show(null);
}
document.addEventListener('visibilitychange', () => { if (document.hidden && !isOnlineGame()) pause(); });

function showEnd(g: Game, human: Player, over: boolean) {
  const won = g.winner === human.id;
  const net = isOnlineGame();
  $('end-title').textContent = won ? 'VICTORY' : over ? `#${human.placement} PLACE` : 'ELIMINATED';
  const winner = g.winner >= 0 ? g.players[g.winner] : null;
  $('end-sub').textContent = won
    ? 'Last Pac-Man standing out of 25.'
    : over
      ? `${winner ? winner.name + ' won the match. ' : ''}You placed #${human.placement} of ${C.PLAYERS}.`
      : `You placed #${human.placement} of ${C.PLAYERS}. Spectate the rest of the match, or ${net ? 'leave for another' : 'start a new one'}.`;
  const outEarly = human.state === 'out' && !won;
  const t = Math.floor(outEarly ? human.stats.outAt : g.time);
  const cells: [string, string][] = [
    [`${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`, outEarly ? 'SURVIVED' : 'MATCH TIME'],
    [String(human.stats.dots), 'PELLETS'],
    [String(human.stats.ghosts), 'GHOSTS EATEN'],
    [String(human.stats.raidersSent), 'RAIDERS SENT'],
  ];
  // Online, your stats arrive with the final results; mid-match they aren't known yet.
  if (net && !over) cells.splice(1);
  $('end-stats').innerHTML = cells.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('');
  $('spectate').style.display = over ? 'none' : '';
  $('again').textContent = net ? (lastOnlineKind === 'quick' ? 'PLAY AGAIN' : 'BACK TO MENU') : 'PLAY AGAIN';
  show('screen-end');
}

// ---------- input ----------

const KEYS: Record<string, number> = {
  ArrowUp: UP, KeyW: UP, ArrowLeft: LEFT, KeyA: LEFT, ArrowDown: DOWN, KeyS: DOWN, ArrowRight: RIGHT, KeyD: RIGHT,
};

function human(): Player | null {
  return game && game.humanId >= 0 ? game.players[game.humanId] : null;
}

function steer(d: number) {
  if (mode !== 'play' || !game) return;
  if (isOnlineGame()) { online!.setDir(d); return; }
  const h = human();
  if (h) game.setDir(h, d);
}

function usePower() {
  if (mode !== 'play' || !game) return;
  const h = human();
  if (!h || h.state !== 'alive') return;
  if (isOnlineGame()) online!.usePower();
  else game.usePower(h);
}

function cycleSpectate(step: number) {
  if (!game || human()?.state !== 'out') return;
  const alive = game.players.filter((p) => p.state !== 'out');
  if (!alive.length) return;
  const i = alive.findIndex((p) => p.id === spectateId);
  spectateId = alive[(i + step + alive.length) % alive.length].id;
}

window.addEventListener('keydown', (e) => {
  if (e.code in KEYS) {
    e.preventDefault();
    steer(KEYS[e.code]);
    return;
  }
  if (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
    e.preventDefault();
    if (mode === 'start') { startSolo(); return; }
    usePower();
    return;
  }
  if (e.code === 'Enter') {
    if (mode === 'start') startSolo();
    else if (mode === 'end') playAgain();
    else if (mode === 'paused') resume();
    else if (mode === 'lobby') online?.startRoom();
    return;
  }
  if (e.code === 'KeyP' || e.code === 'Escape') {
    if (mode === 'play') pause();
    else if (mode === 'paused') resume();
    return;
  }
  if (e.code === 'KeyM') { audio.setMuted(!audio.muted); return; }
  if (e.code === 'Tab' && game && human()?.state === 'out') {
    e.preventDefault();
    cycleSpectate(1);
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
  steer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? RIGHT : LEFT) : dy > 0 ? DOWN : UP);
  touchStart = { x: t.clientX, y: t.clientY };
}, { passive: true });
$('slot').addEventListener('click', usePower);
$('slot').addEventListener('touchstart', (e) => { e.stopPropagation(); usePower(); }, { passive: true });

// Controller.
pads.onConnect = (on) => $('pad-hint').classList.toggle('on', on);
$('pad-hint').classList.toggle('on', pads.connected);

function pollPad(dt: number) {
  const { pressed, nav } = pads.poll(dt);
  if (!pressed.length && nav < 0 && pads.dir < 0) return;
  audio.unlock();
  const has = (b: number) => pressed.includes(b);
  if (mode === 'play') {
    if (pads.dir >= 0) steer(pads.dir);
    if (has(BTN.A) || has(BTN.X) || has(BTN.RB) || has(BTN.RT)) usePower();
    if (has(BTN.START)) pause();
    if (has(BTN.BACK)) audio.setMuted(!audio.muted);
    if (has(BTN.LB)) cycleSpectate(-1);
    if (has(BTN.RB) || has(BTN.Y)) cycleSpectate(1);
    return;
  }
  // Menus: move the highlight, A/Start to press, B to go back.
  const screen = shown ? $(shown) : null;
  if (!screen) return;
  if (nav >= 0) navigate(screen, nav);
  if (has(BTN.A) || has(BTN.START)) {
    if (mode === 'paused' && has(BTN.START)) { resume(); return; }
    const t = padTarget(screen);
    if (t instanceof HTMLButtonElement) t.click();
    else t?.focus();
  }
  if (has(BTN.B)) {
    if (mode === 'paused') resume();
    else if (mode === 'lobby') leaveOnline();
  }
}

/** Short rumbles for things that happen to you. */
function rumbleFor(g: Game, events: GameEvent[], me: Player | null) {
  if (!me || !pads.active) return;
  const vm = g.mazeAt(me.x, me.y);
  for (const e of events) {
    const mine = e.player === me.id;
    if (e.kind === 'death' && mine) pads.rumble(1, 0.8, 450);
    else if (e.kind === 'phase' && mine) pads.rumble(0.3, 0.7, 140);
    else if (e.kind === 'ghost' && mine) pads.rumble(0.35, 0.5, 100);
    else if (e.kind === 'daze' && !mine && e.maze === vm) pads.rumble(0.6, 1, 350);
    else if (e.kind === 'collapseTick' && e.maze === vm && (e.n ?? 9) <= 3) pads.rumble(0.7, 0.3, 140);
  }
}

// ---------- sound routing ----------

function playSounds(g: Game, events: GameEvent[], viewer: Player | null) {
  if (!viewer) return;
  const vm = g.mazeAt(viewer.x, viewer.y);
  for (const e of events) {
    const mine = e.player === viewer.id;
    switch (e.kind) {
      case 'count': audio.count(e.n ?? 0); if (e.n === 0) audio.playing = true; break;
      case 'dot': if (mine) audio.dot(); break;
      case 'power': if (mine || e.maze === vm) audio.power(); break;
      case 'ghost': if (mine || e.maze === vm) { audio.ghost(e.n ?? 1); if (mine && e.target?.length) audio.sent(); } break;
      case 'warp': if (mine) audio.warp(); break;
      case 'door': if (mine) audio.door(); break;
      case 'levelUp': if (e.maze === vm) audio.levelUp(); break;
      case 'death': if (mine) audio.death(); break;
      case 'raiders': if (e.target?.includes(vm)) audio.raiders(); break;
      case 'blackout': case 'frenzy': if (e.target?.includes(vm)) audio.warn(); break;
      case 'dazeCharge': if (mine) audio.dazeCharge(); else if (e.maze === vm) audio.warn(); break;
      case 'daze': if (mine || e.maze === vm) audio.zap(); break;
      case 'collapseStart': if (e.maze === vm) audio.warn(); break;
      case 'collapseTick': if (e.maze === vm) audio.collapseTick(e.n ?? 9, false); else if (g.neighborTargets(vm).includes(e.maze!)) audio.collapseTick(e.n ?? 9, true); break;
      case 'corner': if (mine) audio.corner(e.text === 'phase'); break;
      case 'phase': if (mine) audio.phase(); break;
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

let pingShown = -1;
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  pollPad(dt);
  if (game) {
    const net = isOnlineGame();
    if (net) {
      online!.update(dt); // online matches never pause
    } else if (mode === 'play' && !game.over) {
      acc += dt;
      while (acc >= C.TICK) { game.step(C.TICK); acc -= C.TICK; }
    }
    const h = human();
    const viewer = viewerOf(game);
    if (net && h && h.state === 'out' && viewer) online!.spectate(viewer.id);
    const events = game.events;
    renderer.onEvents(game, events, viewer);
    hud.onEvents(game, events, h);
    if (mode === 'play' || (net && mode !== 'start')) playSounds(game, events, viewer);
    if (h) {
      rumbleFor(game, events, h.state !== 'out' ? h : null);
      for (const e of events) {
        if (e.kind === 'out' && e.player === h.id) { audio.lose(); pads.rumble(1, 1, 700); }
        if (e.kind === 'win' && e.player === h.id) audio.win();
      }
    }
    game.events.length = 0;

    // Music intensity follows the tension of the match.
    const alive = game.players.filter((p) => p.state !== 'out').length;
    audio.intensity = (alive <= 18 ? 1 : 0) + (alive <= 8 || game.time >= C.OVERTIME_START ? 1 : 0) + (h && h.state !== 'out' && h.lives === 1 ? 1 : 0);
    audio.tick();

    renderer.render(game, viewer, mode === 'paused' && !net ? 0 : dt);
    hud.update(game, h, viewer, dt);
    if (net) {
      const ms = Math.round(online!.rtt);
      if (ms !== pingShown) { pingShown = ms; $('ping').textContent = String(ms); }
    }

    if (h && mode === 'play') {
      if (h.state === 'out' && !humanOutHandled && !game.over) {
        humanOutHandled = true;
        const g = game;
        setTimeout(() => { if (game === g && mode === 'play' && !g.over) { mode = 'end'; showEnd(g, h, false); } }, 1200);
      }
    }
    if (h && (mode === 'play' || mode === 'end' || (net && mode === 'paused'))) {
      // Online, wait for the final results (placements and stats) before showing them.
      if (game.over && endShownAt < 0 && (!net || online!.end)) {
        endShownAt = now;
        const g = game;
        setTimeout(() => { if (game === g) { mode = 'end'; audio.playing = false; showEnd(g, h, true); } }, 1800);
      }
    }
  }
  requestAnimationFrame(frame);
}

// Debug/testing hook (read-only access to the running match).
(window as unknown as { __mazeRoyale: object }).__mazeRoyale = {
  get game() { return game; },
  get online() { return online; },
  get mode() { return mode; },
};

// Attract mode: a bot-only match runs behind the start screen.
game = new Game({ seed: 12345, human: false });
requestAnimationFrame((t) => { last = t; requestAnimationFrame(frame); });
setInterval(() => {
  if (mode === 'start' && game && game.humanId < 0) {
    if (game.over) game = new Game({ seed: (Math.random() * 1e9) >>> 0, human: false });
    for (let i = 0; i < 2; i++) game.step(C.TICK);
  }
}, 1000 / 30);
