// Controller support through the Gamepad API (standard mapping: Xbox / PlayStation /
// Switch Pro pads in any modern browser).
//
// Steering: d-pad or left stick. Buttons are reported as presses (edge-triggered) so the
// game can map them to actions; menus get simple focus navigation.

import { DOWN, LEFT, RIGHT, UP } from './movement';

export const BTN = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
} as const;

const DEADZONE = 0.5;
const REPEAT_DELAY = 0.35; // menu navigation auto-repeat
const REPEAT_RATE = 0.12;

export class Gamepads {
  /** Direction held right now (stick or d-pad), -1 when none. */
  dir = -1;
  /** True once any controller has been used. */
  active = false;
  onConnect: (connected: boolean) => void = () => {};

  private prev: boolean[] = [];
  private navDir = -1;
  private navTimer = 0;
  private pad: Gamepad | null = null;

  constructor() {
    window.addEventListener('gamepadconnected', () => this.onConnect(true));
    window.addEventListener('gamepaddisconnected', () => this.onConnect(this.list().length > 0));
  }

  private list(): Gamepad[] {
    if (!navigator.getGamepads) return [];
    return [...navigator.getGamepads()].filter((g): g is Gamepad => !!g && g.connected);
  }

  /**
   * Reads the controllers. Returns buttons pressed since the last poll, and `nav` — a
   * direction for menu movement that fires once, then auto-repeats while held.
   */
  poll(dt: number): { pressed: number[]; nav: number } {
    const pads = this.list();
    // Use whichever pad was touched most recently.
    let pad = this.pad && pads.find((p) => p.index === this.pad!.index) || null;
    for (const p of pads) if (p.buttons.some((b) => b.pressed) || p.axes.some((a) => Math.abs(a) > DEADZONE)) { pad = p; break; }
    this.pad = pad ?? pads[0] ?? null;
    const out: { pressed: number[]; nav: number } = { pressed: [], nav: -1 };
    if (!this.pad) { this.dir = -1; this.prev = []; return out; }
    const b = this.pad.buttons;
    const down = b.map((x) => x.pressed || x.value > 0.5);
    for (let i = 0; i < down.length; i++) if (down[i] && !this.prev[i]) out.pressed.push(i);
    this.prev = down;
    if (out.pressed.length) this.active = true;

    // Direction: d-pad wins; otherwise the stick's dominant axis past the deadzone.
    let dir = -1;
    if (down[BTN.UP]) dir = UP;
    else if (down[BTN.DOWN]) dir = DOWN;
    else if (down[BTN.LEFT]) dir = LEFT;
    else if (down[BTN.RIGHT]) dir = RIGHT;
    else {
      const ax = this.pad.axes[0] ?? 0, ay = this.pad.axes[1] ?? 0;
      if (Math.max(Math.abs(ax), Math.abs(ay)) > DEADZONE) {
        dir = Math.abs(ax) > Math.abs(ay) ? (ax > 0 ? RIGHT : LEFT) : ay > 0 ? DOWN : UP;
      }
    }
    if (dir >= 0) this.active = true;
    this.dir = dir;

    if (dir !== this.navDir) {
      this.navDir = dir;
      this.navTimer = REPEAT_DELAY;
      out.nav = dir;
    } else if (dir >= 0) {
      this.navTimer -= dt;
      if (this.navTimer <= 0) { this.navTimer = REPEAT_RATE; out.nav = dir; }
    }
    return out;
  }

  /** Rumble, on pads that support it. Strengths 0..1. */
  rumble(strong: number, weak: number, ms: number) {
    const act = (this.pad as (Gamepad & { vibrationActuator?: { playEffect?: (t: string, p: object) => Promise<unknown> } }) | null)?.vibrationActuator;
    if (!this.active || !act?.playEffect) return;
    act.playEffect('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
  }

  get connected(): boolean { return this.list().length > 0; }
}

/**
 * Moves a highlight between the visible buttons/inputs of a screen with the d-pad or
 * stick, picking the nearest control in the pressed direction.
 */
export function navigate(root: HTMLElement, dir: number) {
  const items = [...root.querySelectorAll<HTMLElement>('button, input')].filter((el) => el.offsetParent !== null && !(el as HTMLButtonElement).disabled);
  if (!items.length) return;
  const cur = items.find((el) => el.classList.contains('pad-focus'));
  if (!cur) { focusItem(items[0]); return; }
  const r0 = cur.getBoundingClientRect();
  const cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
  // Prefer controls inside a 45° cone in that direction, nearest first; otherwise
  // anything that way at all.
  let best: HTMLElement | null = null, bestScore = Infinity;
  for (const el of items) {
    if (el === cur) continue;
    const r = el.getBoundingClientRect();
    // Measure between facing edges, so wide controls next to each other count as close.
    const horiz = dir === RIGHT || dir === LEFT;
    const along = horiz
      ? (dir === RIGHT ? r.left - r0.right : r0.left - r.right)
      : (dir === DOWN ? r.top - r0.bottom : r0.top - r.bottom);
    const centerAlong = horiz ? (dir === RIGHT ? 1 : -1) * (r.left + r.width / 2 - cx) : (dir === DOWN ? 1 : -1) * (r.top + r.height / 2 - cy);
    if (centerAlong <= 4) continue;
    const across = horiz
      ? Math.max(0, Math.max(r.top, r0.top) - Math.min(r.bottom, r0.bottom))
      : Math.max(0, Math.max(r.left, r0.left) - Math.min(r.right, r0.right));
    const inCone = across <= Math.max(0, along) + 8;
    const score = (inCone ? 0 : 1e6) + Math.max(0, along) + across * 3;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) focusItem(best);
}

export function focusItem(el: HTMLElement) {
  for (const o of document.querySelectorAll('.pad-focus')) o.classList.remove('pad-focus');
  el.classList.add('pad-focus');
  if (el instanceof HTMLInputElement) el.focus();
  else (document.activeElement as HTMLElement | null)?.blur?.();
}

export function clearPadFocus() {
  for (const o of document.querySelectorAll('.pad-focus')) o.classList.remove('pad-focus');
}

/** The highlighted control on a screen, falling back to its first button. */
export function padTarget(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('.pad-focus') ?? root.querySelector<HTMLElement>('button:not(:disabled)');
}
