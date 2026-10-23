// Game server: serves the client page and runs authoritative matches over WebSockets.
//
//   GET /         the game (same page as offline, with online play switched on)
//   GET /healthz  liveness check
//   WS  /ws       play
//
// Matches run the shared simulation (src/game.ts) at 60 Hz. Each connected player sends
// steering frames; the server applies them one per tick, then streams 30 Hz snapshots
// limited to what that player can see (their 3x3 block of mazes, plus a compact view of
// everyone for the minimap). Players who drop are taken over by a CPU brain and can
// reconnect with their token.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import * as C from '../src/config';
import { Game, NET_HOLD } from '../src/game';
import {
  PROTOCOL, FROZEN, SNAPSHOT_EVERY, MAX_HUMANS, LOBBY_SECONDS, neighborhood, mazeRow, playerRow, farRow, ghostRows, raiderRows,
  encodePellets, type ClientMsg, type ServerMsg, type Snapshot, type WireEvent, type LobbyInfo,
} from '../src/net/protocol';

const PORT = Number(process.env.PORT ?? 8080);
const CLIENT = path.resolve(process.env.CLIENT_FILE ?? path.join(process.cwd(), 'dist', 'index.html'));
const RECONNECT_WINDOW = 60_000; // ms a dropped player's slot is held for them
const ROOM_LINGER = 30_000; // ms a finished match stays around for late snapshots/results
const MAX_ROOMS = Number(process.env.MAX_ROOMS ?? 16); // each running match uses roughly 5% of a CPU core
// Late input. By default a player whose next frame hasn't arrived waits for it (one
// tick), which keeps the server's path exactly what the client predicted; MAX_DEBT > 0
// instead keeps them moving through short gaps (smoother for others to watch, but a turn
// in a late frame lands late and the client has to correct). Tested: waiting gives about
// a quarter of the corrections at 140 ms RTT with jitter.
const MAX_DEBT = Number(process.env.MAX_DEBT ?? 0);
const PRIME = Number(process.env.PRIME ?? 2); // frames to buffer before moving (after a spawn or a gap)
const SPEED = Number(process.env.SPEED ?? 1); // testing aid: run matches faster than real time
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

// ---------- connections and rooms ----------

class Conn {
  name = 'PLAYER';
  token = crypto.randomBytes(12).toString('hex');
  room: Room | null = null;
  slot = -1;
  frames: [number, number][] = [];
  debt = 0; // ticks the player moved without a frame from the client
  carry = -1; // steering from a late frame, applied on the next move
  debtAge = 0;
  primed = false;
  ack = 0;
  power = false;
  view = -1;
  alive = true;
  // per-connection sync bookkeeping
  pelletVer = new Map<number, number>();
  mazeRows: string[] = [];
  airdrops = '';
  fullAt = 0;
  constructor(readonly ws: WebSocket, readonly ip: string) {}
  send(msg: ServerMsg) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    // Don't let a slow client's buffer grow without bound: skip snapshots while backed up.
    if (msg.t === 'snap' && this.ws.bufferedAmount > 512 * 1024) return;
    this.ws.send(JSON.stringify(msg));
  }
  resetSync() {
    this.pelletVer.clear();
    this.mazeRows = [];
    this.airdrops = '';
    this.frames = [];
    this.debt = 0;
    this.carry = -1;
    this.debtAge = 0;
    this.primed = false;
  }
}

interface Seat { conn: Conn | null; name: string; token: string; droppedAt: number }

class Room {
  state: 'lobby' | 'playing' | 'over' = 'lobby';
  members = new Set<Conn>();
  host: Conn | null = null;
  startsAt = 0;
  game: Game | null = null;
  seats: Seat[] = [];
  tick = 0;
  events: WireEvent[] = [];
  endedAt = 0;
  constructor(readonly code: string | null) {}

  get isQuick() { return this.code === null; }

  lobbyInfo(c: Conn): LobbyInfo {
    return {
      t: 'lobby', code: this.code, host: this.host === c, names: [...this.members].map((m) => m.name),
      startsIn: this.isQuick && this.startsAt ? Math.max(0, Math.ceil((this.startsAt - Date.now()) / 1000)) : null,
      max: MAX_HUMANS,
    };
  }

  broadcastLobby() {
    for (const m of this.members) m.send(this.lobbyInfo(m));
  }

  add(c: Conn) {
    this.members.add(c);
    c.room = this;
    if (!this.host) this.host = c;
    if (this.isQuick && !this.startsAt) this.startsAt = Date.now() + LOBBY_SECONDS * 1000;
    if (this.members.size >= MAX_HUMANS) this.start();
    else this.broadcastLobby();
  }

  remove(c: Conn) {
    c.room = null;
    if (this.state === 'lobby') {
      this.members.delete(c);
      if (this.host === c) this.host = this.members.values().next().value ?? null;
      if (this.members.size === 0) closeRoom(this);
      else this.broadcastLobby();
      return;
    }
    // In a match: hand the player to a bot. Leaving on purpose frees the seat for good.
    this.members.delete(c);
    const seat = this.seats[c.slot];
    if (seat && this.game) {
      seat.conn = null;
      seat.droppedAt = Date.now();
      this.game.setBotControl(this.game.players[c.slot], true);
    }
  }

  start() {
    if (this.state !== 'lobby') return;
    if (this === quickRoom) quickRoom = null;
    this.state = 'playing';
    const conns = [...this.members];
    const used = new Set<string>();
    const names = conns.map((c) => {
      let n = c.name;
      for (let k = 2; used.has(n); k++) n = `${c.name.slice(0, 8)}${k}`;
      used.add(n);
      return n;
    });
    const seed = crypto.randomInt(1, 2 ** 31);
    this.game = new Game({ seed, human: false, humans: names, countdown: C.COUNTDOWN });
    this.seats = conns.map((c, i) => ({ conn: c, name: names[i], token: c.token, droppedAt: 0 }));
    conns.forEach((c, i) => {
      c.slot = i;
      tokens.set(c.token, { room: this, slot: i });
      c.resetSync();
      this.game!.setBotControl(this.game!.players[i], false);
      c.send({ t: 'start', seed, humans: names, you: i, countdown: C.COUNTDOWN });
    });
    log(`match start room=${this.code ?? 'quick'} humans=${names.length} seed=${seed}`);
  }

  rejoin(c: Conn, slot: number) {
    const seat = this.seats[slot];
    if (!seat || !this.game) return;
    seat.conn = c;
    seat.droppedAt = 0;
    c.room = this;
    c.slot = slot;
    c.name = seat.name;
    c.resetSync();
    this.members.add(c);
    this.game.setBotControl(this.game.players[slot], false);
    const humans = this.seats.map((s) => s.name);
    c.send({ t: 'start', seed: this.game.seed, humans, you: slot, countdown: 0, rejoin: true });
    log(`rejoin room=${this.code ?? 'quick'} slot=${slot}`);
  }

  step() {
    const game = this.game!;
    // Steering frames: each tick moves each player by one of their frames (two when the
    // client is ahead), so the server retraces exactly what the client predicted.
    for (const c of this.members) {
      if (c.slot < 0) continue;
      const p = game.players[c.slot];
      if (c.power) { c.power = false; game.usePower(p); }
      if (game.countdown > 0 || p.netFrames === null || p.state !== 'alive') {
        // Nothing to move: confirm the frames as used so the client doesn't replay them.
        if (c.frames.length) c.ack = c.frames[c.frames.length - 1][0];
        c.frames.length = 0;
        c.debt = 0;
        c.carry = -1;
        c.primed = false;
        continue;
      }
      // After spawning (or GO, or running dry), buffer a couple of frames to absorb jitter.
      if (!c.primed) { if (c.frames.length < PRIME) continue; c.primed = true; }
      // Frozen in a hitstop: hold the frames until it's over (the client kept moving
      // until it heard about it, and those moves still count).
      const m = game.mazes[game.mazeAt(p.x, p.y)];
      if (Math.max(0, m.hitstop - C.TICK) > 0) continue;
      // Frames whose tick already happened without them: apply their steering only.
      while (c.debt > 0 && c.frames.length) {
        const [seq, next] = c.frames.shift()!;
        if (next >= 0 && next <= 3) c.carry = next;
        c.ack = seq;
        c.debt--;
      }
      if (c.frames.length > 60) {
        const drop = c.frames.splice(0, c.frames.length - 4);
        c.ack = drop[drop.length - 1][0];
      }
      const take = c.frames.length > 6 ? 2 : c.frames.length > 0 ? 1 : 0;
      for (let k = 0; k < take; k++) {
        const [seq, next] = c.frames.shift()!;
        if (next >= FROZEN - 1) p.netFrames.push(NET_HOLD);
        else { p.netFrames.push(next >= 0 ? next : c.carry); c.carry = -1; }
        c.ack = seq;
      }
      c.debtAge = c.debt > 0 ? c.debtAge + 1 : 0;
      if (take === 0) {
        // Cover short gaps (up to MAX_DEBT ticks) by moving on; past that, or now and then
        // while running ahead (so a lasting latency rise doesn't keep steering late),
        // pause a tick instead, as if the frame had simply arrived late.
        if (c.debt < MAX_DEBT && c.debtAge < 30) {
          p.netFrames.push(c.carry);
          c.carry = -1;
          c.debt++;
        } else if (c.debtAge >= 30) {
          c.debtAge = 0;
        } else {
          c.primed = false;
        }
      }
    }
    game.step(C.TICK);
    this.tick++;
    for (const e of game.events) {
      const w: WireEvent = e;
      if (game.feed.includes(e)) w.f = 1;
      this.events.push(w);
    }
    game.events.length = 0;
    // Free seats of players who never came back.
    for (const s of this.seats) {
      if (!s.conn && s.droppedAt && Date.now() - s.droppedAt > RECONNECT_WINDOW) {
        tokens.delete(s.token);
        s.droppedAt = 0;
      }
    }
    if (this.tick % SNAPSHOT_EVERY === 0) {
      for (const c of this.members) c.send(this.snapshot(c));
      this.events.length = 0;
    }
    if (game.over && this.state === 'playing') {
      this.state = 'over';
      this.endedAt = Date.now();
      for (const c of this.members) c.send(this.snapshot(c));
      const results = game.players.map((p) => ({
        id: p.id, placement: p.placement, outAt: Math.round(p.stats.outAt), dots: p.stats.dots, ghosts: p.stats.ghosts,
        raidersSent: p.stats.raidersSent,
      }));
      for (const c of this.members) c.send({ t: 'end', winner: game.winner, results });
      log(`match over room=${this.code ?? 'quick'} winner=${game.players[game.winner]?.name} t=${Math.round(game.time)}s`);
    }
  }

  snapshot(c: Conn): Snapshot {
    const game = this.game!;
    const me = game.players[c.slot];
    const viewer = me && me.state === 'out' && c.view >= 0 ? game.players[c.view] : me;
    const center = game.mazeAt(viewer.x, viewer.y);
    const near = new Set(neighborhood(center));
    const P = [], Q = [];
    for (const p of game.players) {
      if (p.id === c.slot || p.id === viewer.id || (p.state !== 'out' && near.has(game.mazeAt(p.x, p.y)))) P.push(playerRow(game, p.id));
      else Q.push(farRow(game, p.id));
    }
    // Maze state: only rows that changed, plus a full refresh every few seconds.
    const full = this.tick - c.fullAt >= 180 || c.mazeRows.length === 0;
    if (full) c.fullAt = this.tick;
    const M = [];
    for (const m of game.mazes) {
      const row = mazeRow(m);
      const key = JSON.stringify(row);
      if (full || c.mazeRows[m.idx] !== key) { M.push(row); c.mazeRows[m.idx] = key; }
    }
    const snap: Snapshot = {
      t: 'snap', tick: this.tick, time: Math.round(game.time * 1000) / 1000, cd: Math.round(game.countdown * 100) / 100,
      over: game.over ? 1 : 0, win: game.winner, ack: c.ack, P, Q, M,
      G: ghostRows(game, near), R: raiderRows(game, near),
    };
    if (c.debt > 0) snap.debt = c.debt;
    const drops = JSON.stringify(game.airdrops.map((a) => [a.id, a.maze, a.x, a.y]));
    if (drops !== c.airdrops) { snap.A = JSON.parse(drops); c.airdrops = drops; }
    // Pellets: full layout for mazes that just came into view or were refilled.
    const PL: [number, number, string][] = [];
    for (const idx of near) {
      const m = game.mazes[idx];
      if (c.pelletVer.get(idx) !== m.pelletVer) {
        PL.push([idx, m.pelletVer, encodePellets(m.pellets)]);
        c.pelletVer.set(idx, m.pelletVer);
      }
    }
    for (const idx of [...c.pelletVer.keys()]) if (!near.has(idx)) c.pelletVer.delete(idx);
    if (PL.length) snap.PL = PL;
    // Events: yours, anything in view, anything aimed at your view, and the feed.
    const E = this.events.filter((e) =>
      e.player === c.slot || e.f === 1 || (e.maze !== undefined && near.has(e.maze)) ||
      (e.target ?? []).some((t) => near.has(t)) || e.kind === 'count' || e.kind === 'win');
    if (E.length) snap.E = E;
    return snap;
  }
}

const rooms = new Map<string, Room>();
const tokens = new Map<string, { room: Room; slot: number }>();
let quickRoom: Room | null = null;

function newCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += letters[crypto.randomInt(letters.length)];
    if (!rooms.has(code)) return code;
  }
}

function closeRoom(room: Room) {
  if (room.code) rooms.delete(room.code);
  if (quickRoom === room) quickRoom = null;
  for (const s of room.seats) tokens.delete(s.token);
  for (const c of room.members) c.room = null;
  room.members.clear();
  allRooms.delete(room);
}

const allRooms = new Set<Room>();

function handle(c: Conn, msg: ClientMsg) {
  switch (msg.t) {
    case 'hello': {
      if (msg.v !== PROTOCOL) { c.send({ t: 'error', msg: 'Your game is out of date. Reload the page.' }); return; }
      c.name = (String(msg.name ?? '').toUpperCase().replace(/[^A-Z0-9 _-]/g, '').trim() || 'PLAYER').slice(0, 10);
      if (msg.token && tokens.has(msg.token)) {
        const { room, slot } = tokens.get(msg.token)!;
        const seat = room.seats[slot];
        if (room.state === 'playing' && seat && !seat.conn) {
          c.token = msg.token;
          room.rejoin(c, slot);
          c.send({ t: 'welcome', token: c.token });
          return;
        }
      }
      c.send({ t: 'welcome', token: c.token });
      return;
    }
    case 'quick': {
      if (c.room) c.room.remove(c);
      if (!quickRoom || quickRoom.state !== 'lobby') {
        if (allRooms.size >= MAX_ROOMS) { c.send({ t: 'error', msg: 'The server is full right now. Try again soon.' }); return; }
        quickRoom = new Room(null);
        allRooms.add(quickRoom);
      }
      const room = quickRoom;
      room.add(c);
      return;
    }
    case 'create': {
      if (c.room) c.room.remove(c);
      if (allRooms.size >= MAX_ROOMS) { c.send({ t: 'error', msg: 'The server is full right now. Try again soon.' }); return; }
      const room = new Room(newCode());
      rooms.set(room.code!, room);
      allRooms.add(room);
      room.add(c);
      return;
    }
    case 'join': {
      const room = rooms.get(String(msg.code ?? '').toUpperCase().trim());
      if (!room) { c.send({ t: 'error', msg: 'No room with that code.' }); return; }
      if (room.state !== 'lobby') { c.send({ t: 'error', msg: 'That match has already started.' }); return; }
      if (room.members.size >= MAX_HUMANS) { c.send({ t: 'error', msg: 'That room is full.' }); return; }
      if (c.room) c.room.remove(c);
      room.add(c);
      return;
    }
    case 'start': {
      const room = c.room;
      if (room && !room.isQuick && room.host === c && room.state === 'lobby') room.start();
      return;
    }
    case 'leave': {
      const room = c.room;
      if (!room) return;
      room.remove(c);
      if (room.state !== 'lobby') {
        // Gave up the seat on purpose: no reconnect.
        tokens.delete(c.token);
        c.token = crypto.randomBytes(12).toString('hex');
        c.send({ t: 'welcome', token: c.token });
      }
      c.send({ t: 'left' });
      return;
    }
    case 'in': {
      if (!c.room || c.slot < 0 || !Array.isArray(msg.f)) return;
      for (const fr of msg.f.slice(0, 40)) {
        const seq = Number(fr[0]), next = Number(fr[1]);
        if (!Number.isFinite(seq) || !((next >= -1 && next <= 3) || (next >= FROZEN - 1 && next <= FROZEN + 3))) continue;
        if (seq <= c.ack || (c.frames.length && seq <= c.frames[c.frames.length - 1][0])) continue;
        c.frames.push([seq, Math.trunc(next)]);
      }
      return;
    }
    case 'power':
      c.power = true;
      return;
    case 'view':
      c.view = Number.isInteger(msg.id) ? msg.id : -1;
      return;
    case 'ping':
      c.send({ t: 'pong', c: Number(msg.c) || 0 });
      return;
  }
}

// ---------- match loop ----------

let last = performance.now();
let acc = 0;
function loop() {
  const now = performance.now();
  acc += Math.min(0.25, (now - last) / 1000) * SPEED;
  last = now;
  let steps = 0;
  while (acc >= C.TICK && steps < 5 * SPEED) {
    acc -= C.TICK;
    steps++;
    for (const room of allRooms) {
      if (room.state === 'lobby' && room.isQuick && room.startsAt && Date.now() >= room.startsAt) room.start();
      if (room.state === 'playing') room.step();
      else if (room.state === 'over' && Date.now() - room.endedAt > ROOM_LINGER) closeRoom(room);
    }
  }
  setTimeout(loop, Math.max(0, (C.TICK - acc) * 1000 - 1));
}

// Lobby countdowns tick on the clients' screens once a second.
setInterval(() => {
  for (const room of allRooms) if (room.state === 'lobby' && room.isQuick) room.broadcastLobby();
}, 1000);

// ---------- HTTP + WebSocket ----------

let page = '';
function loadPage() {
  try {
    page = fs.readFileSync(CLIENT, 'utf8').replace('<meta name="maze-online" content="0">', '<meta name="maze-online" content="1">');
  } catch {
    page = '<!doctype html><title>Maze Royale</title><p>Client not built. Run <code>npm run build</code>.</p>';
  }
}
loadPage();

const server = http.createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  if (url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  if (url === '/' || url === '/index.html') {
    if (process.env.NODE_ENV !== 'production') loadPage();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(page);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', (ws, req) => {
  const ip = String(req.headers['fly-client-ip'] ?? req.socket.remoteAddress ?? '');
  const c = new Conn(ws, ip);
  ws.on('message', (data) => {
    let msg: ClientMsg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    handle(c, msg);
  });
  ws.on('pong', () => { c.alive = true; });
  ws.on('close', () => { if (c.room) c.room.remove(c); });
  ws.on('error', () => { /* close follows */ });
});

// Drop connections that stop answering pings.
setInterval(() => {
  for (const room of allRooms) {
    for (const c of room.members) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      c.ws.ping();
    }
  }
}, 10_000);

server.listen(PORT, () => {
  log(`Maze Royale server on :${PORT} (client: ${CLIENT})`);
  loop();
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { log('shutting down'); process.exit(0); });
