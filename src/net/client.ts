// Online session in the browser.
//
// The server owns the match. This keeps a "mirror" Game (same seed + human list, so the
// same mazes) and updates it from snapshots:
//   - your Pac-Man is predicted locally every tick from your own steering frames, and
//     reconciled against the server by replaying frames it hasn't confirmed yet;
//   - everything else is drawn ~100 ms in the past, interpolated between snapshots;
//   - game events are released when the interpolated time reaches them, so effects line
//     up with what you see.

import * as C from '../config';
import { Game } from '../game';
import { P_DOT, P_POWER } from '../maze';
import { move, wrapDelta, wrapX, wrapY, type Mover } from '../movement';
import type { Raider } from '../types';
import {
  PROTOCOL, FROZEN, applyFarRow, applyMazeRow, applyPlayerRow, decodePellets, ghostStateOf, neighborhood,
  type ClientMsg, type EndMsg, type LobbyInfo, type ServerMsg, type Snapshot, type WireEvent,
} from './protocol';

const INTERP = 0.1; // seconds behind the newest snapshot that remote things are drawn
const TOKEN_KEY = 'maze-royale-token';

interface Frame { seq: number; next: number; moved: boolean }
interface Hist {
  time: number;
  players: Map<number, [number, number, number]>; // x, y, face
  ghosts: Map<number, number[]>;
  raiders: Map<number, number[]>;
}

export type SessionState = 'connecting' | 'menu' | 'lobby' | 'playing' | 'closed';

export class OnlineSession {
  state: SessionState = 'connecting';
  game: Game | null = null;
  you = -1;
  lobby: LobbyInfo | null = null;
  end: EndMsg | null = null;
  rtt = 0;
  onChange: () => void = () => {};
  onError: (msg: string) => void = () => {};

  private ws: WebSocket | null = null;
  private token = '';
  private name = 'PLAYER';
  private url: string;
  private reconnects = 0;
  private wantMatch = false;
  // prediction
  private desired = -1;
  private seq = 0;
  private pending: Frame[] = [];
  private outbox: [number, number][] = [];
  private pred: Mover | null = null;
  private offX = 0; // visual correction offset (tiles), eased to 0
  private offY = 0;
  private acc = 0;
  // interpolation
  private hist: Hist[] = [];
  private clockOffset: number | null = null; // server time - local time
  private queue: WireEvent[] = [];
  private cd = 0;
  private cdAt = 0;
  private pingTimer = 0;
  private viewId = -1; // who you're watching once you're out
  private lastUpdate = 0;

  constructor(url: string) {
    this.url = url;
    try { this.token = sessionStorage.getItem(TOKEN_KEY) ?? ''; } catch { /* storage unavailable */ }
  }

  // ---------- connection ----------

  connect(name: string) {
    this.name = name;
    this.open();
  }

  private open() {
    this.state = this.state === 'playing' ? 'playing' : 'connecting';
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.reconnects = 0;
      this.send({ t: 'hello', v: PROTOCOL, name: this.name, token: this.token || undefined });
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      this.receive(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // Mid-match: keep trying for a while; the server holds the seat for 60 s.
      if (this.state === 'playing' && this.reconnects < 30) {
        this.reconnects++;
        setTimeout(() => this.open(), 1000);
        return;
      }
      this.state = 'closed';
      this.onChange();
    };
  }

  close() {
    this.state = 'closed';
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private send(msg: ClientMsg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  quickPlay() { this.wantMatch = true; this.send({ t: 'quick' }); }
  createRoom() { this.wantMatch = true; this.send({ t: 'create' }); }
  joinRoom(code: string) { this.wantMatch = true; this.send({ t: 'join', code }); }
  startRoom() { this.send({ t: 'start' }); }
  leave() {
    this.wantMatch = false;
    this.send({ t: 'leave' });
    this.state = 'menu';
    this.lobby = null;
    this.game = null;
    this.end = null;
    this.onChange();
  }
  setDir(d: number) { this.desired = d; }
  usePower() { this.send({ t: 'power' }); }
  spectate(id: number) {
    if (id === this.viewId) return;
    this.viewId = id;
    this.send({ t: 'view', id });
  }

  private receive(msg: ServerMsg) {
    switch (msg.t) {
      case 'welcome':
        this.token = msg.token;
        try { sessionStorage.setItem(TOKEN_KEY, msg.token); } catch { /* storage unavailable */ }
        if (this.state === 'connecting') { this.state = 'menu'; this.onChange(); }
        return;
      case 'lobby':
        if (!this.wantMatch) return;
        this.lobby = msg;
        this.state = 'lobby';
        this.onChange();
        return;
      case 'start':
        this.begin(msg.seed, msg.humans, msg.you, msg.countdown);
        return;
      case 'snap':
        this.applySnapshot(msg);
        return;
      case 'end':
        this.end = msg;
        if (this.game) {
          for (const r of msg.results) {
            const p = this.game.players[r.id];
            p.placement = r.placement;
            p.stats.outAt = r.outAt; p.stats.dots = r.dots; p.stats.ghosts = r.ghosts; p.stats.raidersSent = r.raidersSent;
          }
          this.game.over = true;
          this.game.winner = msg.winner;
        }
        this.onChange();
        return;
      case 'error':
        this.onError(msg.msg);
        return;
      case 'pong':
        this.rtt = performance.now() - msg.c;
        return;
      case 'left':
        return;
    }
  }

  // ---------- match setup ----------

  private begin(seed: number, humans: string[], you: number, countdown: number) {
    const game = new Game({ seed, human: false, humans, countdown });
    game.humanId = you;
    game.events.length = 0; // initial board rolls aren't news
    this.game = game;
    this.you = you;
    this.end = null;
    this.lobby = null;
    this.state = 'playing';
    this.pending = [];
    this.outbox = [];
    this.pred = null;
    this.offX = this.offY = 0;
    this.hist = [];
    this.queue = [];
    this.clockOffset = null;
    this.desired = -1;
    this.viewId = -1;
    this.cd = countdown;
    this.cdAt = performance.now() / 1000;
    this.onChange();
  }

  // ---------- snapshots ----------

  private applySnapshot(s: Snapshot) {
    const game = this.game;
    if (!game) return;
    const now = performance.now() / 1000;
    const sample = s.time - now;
    if (this.clockOffset === null || sample > this.clockOffset + 0.25 || sample < this.clockOffset - 0.25) this.clockOffset = sample;
    else this.clockOffset += (sample - this.clockOffset) * 0.05;
    this.cd = s.cd;
    this.cdAt = now;
    game.over = s.over === 1;
    game.winner = s.win;

    for (const row of s.M) applyMazeRow(game, row);
    const h: Hist = { time: s.time, players: new Map(), ghosts: new Map(), raiders: new Map() };
    for (const row of s.P) { applyPlayerRow(game, row); h.players.set(row[0], [row[1], row[2], row[5]]); }
    for (const row of s.Q) { applyFarRow(game, row); h.players.set(row[0], [row[1], row[2], -1]); }
    for (const row of s.G) h.ghosts.set(row[0], row);
    for (const row of s.R) h.raiders.set(row[0], row);
    this.hist.push(h);
    if (this.hist.length > 40) this.hist.shift();
    if (s.A) game.airdrops = s.A.map(([id, maze, x, y]) => ({ id, maze, x, y }));

    // Ghost objects: create any new ones (overtime adds ghosts); drop ones that vanished in view.
    const byId = new Map(game.ghosts.map((g) => [g.id, g]));
    const near = new Set(neighborhood(this.viewMaze()));
    for (const row of s.G) {
      let g = byId.get(row[0]);
      if (!g) {
        g = { id: row[0], maze: row[1], kind: row[2], x: row[3], y: row[4], dir: row[5], next: -1, state: 'house', timer: 0, eatenGen: -1, emerge: 0 };
        game.ghosts.push(g);
        byId.set(g.id, g);
      }
      g.maze = row[1]; g.kind = row[2]; g.dir = row[5]; g.state = ghostStateOf(row[6]); g.eatenGen = row[7]; g.emerge = row[8]; g.timer = row[9];
    }
    const seen = new Set(s.G.map((r) => r[0]));
    for (const g of game.ghosts) if (near.has(g.maze) && !seen.has(g.id) && g.state !== 'gone') g.state = 'gone';

    // Events wait in a queue until the interpolated clock reaches them; pellet changes
    // apply right away (they're idempotent, and full layouts below override them).
    if (s.E) {
      for (const e of s.E) {
        if ((e.kind === 'dot' || e.kind === 'power') && e.x !== undefined) this.clearPellet(e.x, e.y!);
        this.queue.push(e);
      }
    }
    if (s.PL) for (const [idx, , data] of s.PL) decodePellets(data, game.mazes[idx].pellets);

    this.reconcile(s);
  }

  private clearPellet(x: number, y: number) {
    const game = this.game!;
    const { m, i } = game.tileIndex(x, y);
    m.pellets[i] = 0;
  }

  // ---------- your Pac-Man: prediction ----------

  private reconcile(s: Snapshot) {
    const game = this.game!;
    const me = game.players[this.you];
    const row = s.P.find((r) => r[0] === this.you);
    if (!row) return;
    this.pending = this.pending.filter((f) => f.seq > s.ack);
    if (me.state !== 'alive') {
      this.pred = { x: row[1], y: row[2], dir: row[3], next: row[4] };
      me.x = row[1]; me.y = row[2]; me.dir = row[3]; me.face = row[5];
      this.pending = [];
      this.offX = this.offY = 0;
      return;
    }
    // Replay unconfirmed frames on top of the server's position.
    // The server may already have moved for frames it hasn't received yet (they ran
    // late); it will only take their steering, so the replay does the same.
    const r: Mover = { x: row[1], y: row[2], dir: row[3], next: row[4] };
    let debt = s.debt ?? 0;
    for (const f of this.pending) {
      if (debt > 0) { debt--; if (f.next >= 0) r.next = f.next; continue; }
      if (f.moved) this.stepMover(r, f.next, false);
    }
    if (this.pred) {
      const ex = wrapDelta(this.pred.x - r.x, C.WORLD_W), ey = wrapDelta(this.pred.y - r.y, C.WORLD_H);
      if (Math.abs(ex) + Math.abs(ey) < 2) { this.offX += ex; this.offY += ey; } else { this.offX = this.offY = 0; }
    }
    this.pred = r;
  }

  /** One tick of movement for a predicted mover; `live` also produces local effects. */
  private stepMover(m: Mover, next: number, live: boolean) {
    const game = this.game!;
    const maze = game.mazes[game.mazeAt(m.x, m.y)];
    if (next >= 0) m.next = next;
    const ox = m.x, oy = m.y, oMaze = maze.idx;
    move(m, game.pacSpeed(maze.level) * C.TICK, {
      canEnter: game.pacCanEnter,
      tunnel: true,
      cornerCut: C.CORNER_CUT,
      onCorner: live ? (_cut, fx, fy, fdir) => {
        const me = game.players[this.you];
        game.events.push({ kind: 'corner', time: game.time, player: this.you, maze: oMaze, x: m.x, y: m.y, x2: fx, y2: fy, n: fdir, text: me.phaseCd <= 0 ? 'phase' : '', color: me.color });
      } : undefined,
    });
    if (!live) return;
    // Local effects for things only you cause: eating, warps, doors.
    const me = game.players[this.you];
    const nm = game.mazeAt(m.x, m.y);
    if (Math.abs(wrapDelta(m.x - ox, C.WORLD_W)) > 2) {
      game.events.push({ kind: 'warp', time: game.time, player: this.you, maze: nm, x: Math.round(ox), y: Math.round(oy), x2: m.x, y2: m.y });
    } else if (nm !== oMaze) {
      game.events.push({ kind: 'door', time: game.time, player: this.you, maze: nm, n: oMaze, x: m.x, y: m.y });
    }
    const t = game.tileIndex(m.x, m.y);
    const pel = t.m.pellets[t.i];
    if (pel === P_DOT || pel === P_POWER) {
      t.m.pellets[t.i] = 0;
      game.events.push({ kind: pel === P_DOT ? 'dot' : 'power', time: game.time, player: me.id, maze: t.m.idx, x: Math.round(m.x), y: Math.round(m.y) });
    }
  }

  private viewMaze(): number {
    const game = this.game!;
    const me = game.players[this.you];
    const v = me.state === 'out' && this.viewId >= 0 ? game.players[this.viewId] : me;
    return game.mazeAt(v.x, v.y);
  }

  // ---------- per frame ----------

  /** Advances prediction and interpolation; fills game.events with what to show this frame. */
  update(dt: number) {
    const game = this.game;
    if (!game) return;
    const now = performance.now() / 1000;
    // Prediction keeps real time even when frames are slow (the caller clamps dt for
    // animation); after a long stall (background tab) the server has moved on anyway.
    const realDt = this.lastUpdate ? now - this.lastUpdate : dt;
    this.lastUpdate = now;
    // Countdown runs locally between snapshots (and makes its own 3-2-1-GO events, since
    // the server's all carry match time 0).
    const before = Math.ceil(game.countdown);
    game.countdown = Math.max(0, this.cd - (now - this.cdAt));
    const after = Math.ceil(game.countdown);
    if (after < before) game.events.push({ kind: 'count', time: game.time, n: after });

    // Prediction at the simulation rate.
    const me = game.players[this.you];
    if (me.state !== 'alive') this.desired = -1;
    if (realDt < 0.5) this.acc += realDt;
    while (this.acc >= C.TICK) {
      this.acc -= C.TICK;
      if (game.countdown > 0 || me.state !== 'alive' || !this.pred || game.over) continue;
      const maze = game.mazes[game.mazeAt(this.pred.x, this.pred.y)];
      const frozen = me.daze > 0 || maze.hitstop > 0;
      const f: Frame = { seq: ++this.seq, next: this.desired, moved: !frozen };
      this.pending.push(f);
      this.outbox.push([f.seq, frozen ? f.next + FROZEN : f.next]);
      if (!frozen) this.stepMover(this.pred, f.next, true);
      if (this.pending.length > 240) this.pending.shift();
    }
    if (this.outbox.length) { this.send({ t: 'in', f: this.outbox }); this.outbox = []; }

    // Ease out prediction corrections.
    const k = Math.exp(-dt * 12);
    this.offX *= k; this.offY *= k;
    if (this.pred && me.state === 'alive') {
      me.x = wrapX(this.pred.x + this.offX);
      me.y = wrapY(this.pred.y + this.offY);
      me.dir = this.pred.dir;
      if (this.pred.dir >= 0) me.face = this.pred.dir;
    }

    // Everything else, drawn slightly in the past.
    const rt = (this.clockOffset === null ? 0 : now + this.clockOffset) - INTERP;
    this.interpolate(game, rt);
    game.time = Math.max(game.time, rt);
    game.rebuildInMaze();

    // Release events that have come due. Your own eats/warps/doors/corners were shown
    // locally already, so the server's copies are skipped.
    let n = 0;
    while (n < this.queue.length && this.queue[n].time <= rt) n++;
    const due = this.queue.splice(0, n);
    for (const e of due) {
      if (e.kind === 'count') continue;
      if (e.time < rt - 0.5) { // stale (e.g. the tab was in the background): keep the feed, skip the effects
        if (e.f === 1) { game.feed.push(e); if (game.feed.length > 40) game.feed.shift(); }
        continue;
      }
      const own = e.player === this.you && (e.kind === 'dot' || e.kind === 'power' || e.kind === 'warp' || e.kind === 'door' || e.kind === 'corner');
      if (e.f === 1) { game.feed.push(e); if (game.feed.length > 40) game.feed.shift(); }
      if (!own) game.events.push(e);
    }
    // Ping every 2 s for the HUD.
    if (now - this.pingTimer > 2) { this.pingTimer = now; this.send({ t: 'ping', c: performance.now() }); }
  }

  private interpolate(game: Game, rt: number) {
    const H = this.hist;
    if (!H.length) return;
    let a = H[0], b = H[H.length - 1];
    for (let i = H.length - 1; i > 0; i--) {
      if (H[i - 1].time <= rt) { a = H[i - 1]; b = H[i]; break; }
    }
    const span = b.time - a.time;
    const t = span > 0 ? Math.min(1, Math.max(0, (rt - a.time) / span)) : 1;
    const lerp = (x0: number, y0: number, x1: number, y1: number): [number, number] => {
      const dx = wrapDelta(x1 - x0, C.WORLD_W), dy = wrapDelta(y1 - y0, C.WORLD_H);
      if (Math.abs(dx) + Math.abs(dy) > 2.5) return [x1, y1]; // warped or respawned: don't slide
      return [wrapX(x0 + dx * t), wrapY(y0 + dy * t)];
    };
    for (const p of game.players) {
      if (p.id === this.you && p.state === 'alive' && this.pred) continue;
      const pb = b.players.get(p.id);
      if (!pb) continue;
      const pa = a.players.get(p.id) ?? pb;
      [p.x, p.y] = lerp(pa[0], pa[1], pb[0], pb[1]);
      if (pb[2] >= 0) { p.face = pb[2]; p.dir = pb[2]; }
    }
    const byId = new Map(game.ghosts.map((g) => [g.id, g]));
    for (const [id, gb] of b.ghosts) {
      const g = byId.get(id);
      if (!g) continue;
      const ga = a.ghosts.get(id) ?? gb;
      [g.x, g.y] = lerp(ga[3], ga[4], gb[3], gb[4]);
    }
    const raiders: Raider[] = [];
    for (const [id, rb] of b.raiders) {
      const ra = a.raiders.get(id) ?? rb;
      const [x, y] = lerp(ra[3], ra[4], rb[3], rb[4]);
      raiders.push({ id, maze: rb[1], sender: rb[2], x, y, dir: rb[5], next: -1, life: rb[6], materialize: rb[7], grace: rb[8], dead: false });
    }
    game.raiders = raiders;
    for (const m of game.mazes) m.raiderCount = 0;
    for (const r of raiders) game.mazes[r.maze].raiderCount++;
  }
}

/** True when the page was served by the game server (online play available). */
export function onlineAvailable(): boolean {
  const meta = document.querySelector('meta[name="maze-online"]');
  return !!meta && meta.getAttribute('content') === '1';
}

export function serverUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

