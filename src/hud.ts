// DOM heads-up display layered over the canvas: lives and location, players left,
// held power-up and charge, event feed, center banners and the 5x5 minimap.

import * as C from './config';
import { mazeName, type Game } from './game';
import type { GameEvent, Player, PowerKind } from './types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export const POWER_INFO: Record<PowerKind, { name: string; desc: string; color: string; icon: string }> = {
  blackout: {
    name: 'BLACKOUT',
    desc: 'Neighboring mazes go dark for 8s',
    color: '#FF7FDA',
    icon: '<svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true"><path d="M27 8a13 13 0 1 0 5 21A11 11 0 0 1 27 8z" fill="#FF7FDA"/><circle cx="29" cy="11" r="2" fill="#E9EDFF"/></svg>',
  },
  frenzy: {
    name: 'FRENZY',
    desc: 'Neighbors’ ghosts hunt faster for 10s',
    color: '#FF8A5A',
    icon: '<svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true"><path d="M20 5c2 6 9 9 9 18a9 9 0 0 1-18 0c0-5 3-7 4-11 2 3 2 5 4 6 1-5 0-9 1-13z" fill="#FF8A5A"/><path d="M20 22c1 3 4 4 4 7a4 4 0 0 1-8 0c0-2 2-4 4-7z" fill="#FFD84A"/></svg>',
  },
  daze: {
    name: 'DAZE',
    desc: 'Freezes rivals in this maze for 4s',
    color: '#7DE3FF',
    icon: '<svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true"><rect x="13" y="17" width="14" height="14" rx="3" transform="rotate(45 20 24)" fill="#7DE3FF"/><path d="M8 10l4 3M20 4v5M32 10l-4 3" stroke="#E9EDFF" stroke-width="2.4" stroke-linecap="round"/></svg>',
  },
};

export class Hud {
  private cache = new Map<string, string>();
  private minimap: HTMLCanvasElement;
  private mctx: CanvasRenderingContext2D;
  private mapTimer = 0;
  private feedShown = '';
  private bannerUntil = 0;
  private flash: { text: string; color: string; until: number } | null = null;

  constructor() {
    this.minimap = $('minimap');
    this.mctx = this.minimap.getContext('2d')!;
  }

  private set(id: string, html: string) {
    if (this.cache.get(id) === html) return;
    this.cache.set(id, html);
    $(id).innerHTML = html;
  }

  private text(id: string, text: string) {
    if (this.cache.get(id) === text) return;
    this.cache.set(id, text);
    $(id).textContent = text;
  }

  /** Short-lived center message (e.g. "SENT 3 RAIDERS"). */
  flashMessage(text: string, color: string, now: number, secs = 1.6) {
    this.flash = { text, color, until: now + secs };
  }

  onEvents(game: Game, events: GameEvent[], me: Player | null) {
    if (!me) return;
    for (const e of events) {
      if (e.kind === 'raiders' && e.player === me.id) this.flashMessage(`SENT RAIDERS → ${e.target!.map(mazeName).join(' ')}`, '#FFD84A', game.time);
      if (e.kind === 'pickup' && e.player === me.id && me.human) this.flashMessage(`GOT ${POWER_INFO[e.text as PowerKind].name}`, POWER_INFO[e.text as PowerKind].color, game.time);
      if (e.kind === 'reload' && e.player === me.id) this.flashMessage('HOME POWER PELLETS RELOADED', '#FFF3D1', game.time);
      if (e.kind === 'fruit' && e.player === me.id) this.flashMessage('FRUIT!', '#FF8FA0', game.time, 1);
    }
  }

  update(game: Game, me: Player | null, viewer: Player | null, dt: number) {
    const human = game.players[game.humanId];
    // ---- top-left: lives and location
    const p = viewer ?? human;
    if (p) {
      this.text('me-name', p.human ? p.name : `WATCHING ${p.name}`);
      $('me-name').style.color = p.human ? '#FFD84A' : p.color;
      let lives = '';
      for (let i = 0; i < C.LIVES; i++) lives += `<span class="life${i < p.lives ? '' : ' lost'}"></span>`;
      this.set('me-lives', lives + `<span class="muted">${p.lives === 1 ? 'last life' : p.lives + ' lives'}</span>`);
      const m = game.mazes[game.mazeAt(p.x, p.y)];
      const pal = C.LEVEL_PALETTE[m.level];
      const owner = m.owner >= 0 ? game.players[m.owner] : null;
      const whose = m.idx === p.home ? 'home' : owner ? `${escapeHtml(owner.name)}’s home` : '';
      this.set('me-where', `In <b style="color:${pal[1]}">${mazeName(m.idx)} · Lv ${m.level}</b>${whose ? ' · ' + whose : ''}`);
    }
    // ---- top-center: players left and clock
    const alive = game.players.filter((q) => q.state !== 'out').length;
    this.set('remaining', `${alive}<span class="dim">/${C.PLAYERS}</span>`);
    const t = Math.floor(game.time);
    this.text('clock', `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`);
    this.text('clock-label', game.time >= C.OVERTIME_START ? 'OVERTIME' : 'MATCH');
    $('clock-label').style.color = game.time >= C.OVERTIME_START ? '#FF7A87' : '';
    // ---- top-right: power-up slot and charge
    const holder = me ?? p;
    if (holder) {
      const slot = holder.slot;
      if (slot) {
        const info = POWER_INFO[slot];
        this.set('slot-icon', info.icon);
        this.text('slot-name', info.name);
        $('slot-name').style.color = info.color;
        this.text('slot-desc', info.desc);
        $('slot').classList.add('ready');
      } else {
        this.set('slot-icon', '');
        this.text('slot-name', holder.dazeCharge > 0 ? 'CHARGING…' : 'EMPTY');
        $('slot-name').style.color = '#5A6080';
        this.text('slot-desc', 'Eat pellets to charge — away from home counts double');
        $('slot').classList.remove('ready');
      }
      const pct = Math.round((holder.charge / C.CHARGE_FULL) * 100);
      this.text('charge-pct', `${pct}%`);
      $('charge-fill').style.width = `${pct}%`;
    }
    // ---- bottom-left: feed
    // Only what matters to the viewer: things they did, things aimed at their
    // maze or its neighbors, and world events (eliminations, airdrops, overtime).
    const focus = viewer ?? me;
    const near = focus ? new Set([focus.maze, ...game.neighborTargets(focus.maze)]) : null;
    const relevant = game.feed.filter((e) =>
      !focus || e.player === focus.id || ['out', 'collapse', 'airdrop', 'overtime', 'win'].includes(e.kind) ||
      (e.target ?? []).some((t) => near!.has(t)) || (e.maze !== undefined && near!.has(e.maze)));
    const feedKey = relevant.map((e) => e.time.toFixed(2)).join('|');
    if (feedKey !== this.feedShown) {
      this.feedShown = feedKey;
      const rows = relevant.slice(-4).map((e) => {
        const color = e.color ?? '#A3ABCF';
        return `<div class="feed-row"><i style="background:${color}"></i><span>${escapeHtml(e.text ?? '')}</span></div>`;
      });
      $('feed').innerHTML = rows.join('');
    }
    // ---- center banner
    this.updateBanner(game, viewer, human);
    // ---- minimap (a few times a second is plenty)
    this.mapTimer -= dt;
    if (this.mapTimer <= 0) {
      this.mapTimer = 0.2;
      this.drawMinimap(game, viewer);
    }
  }

  private updateBanner(game: Game, viewer: Player | null, human: Player | undefined) {
    let text = '';
    let color = '#E9EDFF';
    let danger = false;
    const v = viewer;
    if (v && v.state !== 'out') {
      const m = game.mazes[game.mazeAt(v.x, v.y)];
      const incoming = game.raiders.find((r) => !r.dead && r.maze === m.idx && r.materialize > 0);
      if (v.state === 'dying') { text = v.lives > 0 ? 'RESPAWNING AT HOME' : 'ELIMINATED'; color = '#FF7A87'; }
      else if (v.daze > 0) { text = `DAZED ${v.daze.toFixed(1)}`; color = '#7DE3FF'; }
      else if (m.collapseTimer > 0) { text = `⚠ ${mazeName(m.idx)} COLLAPSES IN ${Math.ceil(m.collapseTimer)} — GET OUT`; color = '#FF4D5E'; danger = true; }
      else if (game.inMaze[m.idx].some((q) => q !== v && q.dazeCharge > 0)) { text = 'DAZE CHARGING — LEAVE THE MAZE!'; color = '#7DE3FF'; }
      else if (incoming) { text = `RAIDERS INCOMING FROM ${game.players[incoming.sender].name}`; color = game.players[incoming.sender].color; }
      else if (m.blackoutWarn > 0) { text = 'BLACKOUT INCOMING'; color = '#FF7FDA'; }
      else if (m.frenzyWarn > 0) { text = 'FRENZY INCOMING'; color = '#FF8A5A'; }
      else if (m.blackout > 0) { text = `BLACKOUT ${Math.ceil(m.blackout)}s${m.effectBy >= 0 ? ' · FROM ' + game.players[m.effectBy].name : ''}`; color = '#FF7FDA'; }
      else if (m.frenzy > 0) { text = `FRENZY ${Math.ceil(m.frenzy)}s`; color = '#FF8A5A'; }
      else if (m.frightTimer > 0) { text = `POWER ${m.frightTimer.toFixed(1)}`; color = '#9AB0FF'; }
    }
    if (!text && this.flash && game.time < this.flash.until) { text = this.flash.text; color = this.flash.color; }
    if (!text && human && human.state === 'out' && !game.over) { text = `YOU PLACED #${human.placement} · SPECTATING`; color = '#A3ABCF'; }
    const el = $('banner');
    if (text) {
      this.bannerUntil = game.time + 0.1;
      this.text('banner', text);
      el.style.color = color;
      el.style.borderColor = color;
      el.classList.toggle('danger', danger);
      el.classList.add('show');
    } else if (game.time > this.bannerUntil) {
      el.classList.remove('show');
    }
  }

  private drawMinimap(game: Game, viewer: Player | null) {
    const ctx = this.mctx;
    const W = this.minimap.width, H = this.minimap.height;
    const cw = W / C.GRID, ch = H / C.GRID;
    ctx.clearRect(0, 0, W, H);
    for (const m of game.mazes) {
      const x = m.mx * cw + 2, y = m.my * ch + 2, w = cw - 4, h = ch - 4;
      if (m.collapsed) {
        ctx.fillStyle = '#0B0D16';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = '#1F2438';
        ctx.lineWidth = 1;
        ctx.save();
        ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
        for (let k = -h; k < w; k += 6) { ctx.beginPath(); ctx.moveTo(x + k, y); ctx.lineTo(x + k + h, y + h); ctx.stroke(); }
        ctx.restore();
        continue;
      }
      const c = C.LEVEL_PALETTE[m.level][0];
      ctx.fillStyle = c + '2E';
      ctx.fillRect(x, y, w, h);
      const flashing = m.collapseTimer > 0 && Math.floor(game.time * 4) % 2 === 0;
      if (m.collapseTimer > 0) {
        ctx.fillStyle = flashing ? 'rgba(255,47,74,0.75)' : 'rgba(255,47,74,0.35)';
        ctx.fillRect(x, y, w, h);
      }
      ctx.strokeStyle = flashing ? '#FF4D5E' : c;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(viewer && m.idx === viewer.home ? [3, 2] : []);
      if (viewer && m.idx === viewer.home) ctx.strokeStyle = '#FFD84A';
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      if (m.fruit) { ctx.fillStyle = '#FF4D5E'; ctx.beginPath(); ctx.arc(x + w - 5, y + 5, 2.5, 0, Math.PI * 2); ctx.fill(); }
      if (m.collapseTimer > 0) {
        ctx.fillStyle = '#FFFFFF';
        ctx.font = '800 16px Orbitron, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(Math.ceil(m.collapseTimer)), x + w / 2, y + h / 2 + 1);
      }
    }
    if (viewer) {
      const vm = game.mazes[game.mazeAt(viewer.x, viewer.y)];
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.strokeRect(vm.mx * cw + 1, vm.my * ch + 1, cw - 2, ch - 2);
    }
    for (const a of game.airdrops) {
      const m = game.mazes[a.maze];
      ctx.strokeStyle = '#7DE3FF';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(m.mx * cw + 4, m.my * ch + ch - 10, 6, 6);
    }
    // Leader: most lives, then most pellets.
    const alive = game.players.filter((q) => q.state !== 'out');
    const leader = alive.slice().sort((a, b) => b.lives - a.lives || b.stats.dots - a.stats.dots)[0];
    for (const q of alive) {
      const px = (q.x / C.MW) * cw, py = (q.y / C.MH) * ch;
      const me = viewer && q.id === viewer.id;
      ctx.fillStyle = me ? '#FFD84A' : q.state === 'dying' ? '#5A6080' : '#E9EDFF';
      if (me) {
        ctx.save(); ctx.translate(px, py); ctx.rotate(Math.PI / 4); ctx.fillRect(-3.5, -3.5, 7, 7); ctx.restore();
      } else {
        ctx.beginPath(); ctx.arc(px, py, 2.2, 0, Math.PI * 2); ctx.fill();
      }
      if (leader && q.id === leader.id && alive.length > 1) {
        ctx.fillStyle = '#FFD84A';
        ctx.beginPath();
        ctx.moveTo(px - 5, py - 4); ctx.lineTo(px - 5, py - 9); ctx.lineTo(px - 2, py - 6); ctx.lineTo(px, py - 10);
        ctx.lineTo(px + 2, py - 6); ctx.lineTo(px + 5, py - 9); ctx.lineTo(px + 5, py - 4); ctx.closePath(); ctx.fill();
      }
    }
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
