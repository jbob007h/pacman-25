// Synthesized sound and music (Web Audio, no asset files). Pellet blips walk a
// pentatonic scale in key with the music; the music adds layers as the match
// gets tense (fewer players left, your last life, overtime).

const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21]; // major pentatonic, two octaves
const ROOT = 220; // A3
const freq = (semi: number) => ROOT * Math.pow(2, semi / 12);

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private dotStep = 0;
  private lastDot = 0;
  private nextBeat = 0;
  private beat = 0;
  muted = false;
  intensity = 0; // 0..3
  playing = false;

  /** Must be called from a user gesture (browsers block audio until then). */
  unlock() {
    if (this.ctx) { void this.ctx.resume(); return; }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.6;
    this.master.connect(ctx.destination);
    this.sfxGain = ctx.createGain();
    this.sfxGain.gain.value = 0.8;
    this.sfxGain.connect(this.master);
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = 0.35;
    this.musicGain.connect(this.master);
    const len = ctx.sampleRate * 0.5;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.nextBeat = ctx.currentTime + 0.1;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.6, this.ctx.currentTime, 0.02);
  }

  private tone(f: number, dur: number, type: OscillatorType, vol: number, when = 0, slideTo?: number, out?: AudioNode) {
    if (!this.ctx || !this.sfxGain) return;
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(out ?? this.sfxGain);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private hiss(dur: number, vol: number, hp: number, when = 0, out?: AudioNode) {
    if (!this.ctx || !this.noise || !this.sfxGain) return;
    const t = this.ctx.currentTime + when;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = hp;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(out ?? this.sfxGain);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  dot() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (now - this.lastDot > 0.6) this.dotStep = 0;
    this.lastDot = now;
    const semi = SCALE[this.dotStep % SCALE.length] + 12;
    this.dotStep++;
    this.tone(freq(semi), 0.07, 'square', 0.05);
  }
  power() { this.tone(freq(12), 0.35, 'sawtooth', 0.12, 0, freq(24)); this.tone(freq(19), 0.3, 'square', 0.06, 0.05); }
  /** Ghost eaten; each ghost in a combo climbs higher. */
  ghost(combo = 1) {
    const up = (Math.min(combo, 6) - 1) * 3;
    this.tone(90, 0.18, 'sine', 0.4, 0, 40); // thump under the hit-pause
    [24, 28, 31, 36].forEach((s, i) => this.tone(freq(s + up), 0.08, 'square', 0.09, 0.02 + i * 0.04));
  }
  /** Side-tunnel warp: a rising zip. */
  warp() { this.tone(freq(0), 0.22, 'sine', 0.12, 0, freq(31)); this.hiss(0.18, 0.08, 3000); }
  /** Walking through a door into another maze. */
  door() { this.hiss(0.22, 0.1, 900); this.tone(freq(7), 0.12, 'triangle', 0.06, 0.02, freq(14)); }
  levelUp() { [12, 19, 24, 31, 36].forEach((s, i) => this.tone(freq(s), 0.12, 'sawtooth', 0.06, i * 0.05)); }
  death() { this.tone(freq(12), 0.9, 'sawtooth', 0.15, 0, freq(-12)); this.hiss(0.4, 0.15, 800, 0.1); }
  raiders() { this.tone(freq(7), 0.12, 'sawtooth', 0.1); this.tone(freq(6), 0.12, 'sawtooth', 0.1, 0.14); this.tone(freq(7), 0.12, 'sawtooth', 0.1, 0.28); }
  sent() { this.tone(freq(19), 0.1, 'triangle', 0.12); this.tone(freq(24), 0.16, 'triangle', 0.12, 0.08); }
  pickup() { [12, 16, 19, 24].forEach((s, i) => this.tone(freq(s), 0.1, 'triangle', 0.12, i * 0.05)); }
  fruit() { [24, 21, 24, 28, 31].forEach((s, i) => this.tone(freq(s), 0.1, 'square', 0.08, i * 0.06)); }
  warn() { this.tone(freq(0), 0.18, 'square', 0.08); this.tone(freq(0), 0.18, 'square', 0.08, 0.25); }
  dazeCharge() { this.tone(freq(0), 1.0, 'sine', 0.12, 0, freq(24)); }
  zap() { this.hiss(0.3, 0.2, 2000); this.tone(freq(31), 0.25, 'sawtooth', 0.08, 0, freq(7)); }
  collapse() { this.tone(55, 1.2, 'sawtooth', 0.18, 0, 30); this.hiss(1.0, 0.18, 200); }
  airdrop() { this.tone(freq(24), 0.08, 'sine', 0.1); this.tone(freq(31), 0.2, 'sine', 0.1, 0.08); }
  /** Countdown beeps: 3, 2, 1 low; GO is a bright chord. */
  count(n: number) {
    if (n > 0) { this.tone(freq(12), 0.16, 'square', 0.1); return; }
    [24, 28, 31].forEach((s) => this.tone(freq(s), 0.45, 'square', 0.07));
    this.tone(70, 0.25, 'sine', 0.4, 0, 35);
  }
  win() { [12, 16, 19, 24, 28, 31, 36].forEach((s, i) => this.tone(freq(s), 0.2, 'square', 0.08, i * 0.09)); }
  lose() { [12, 11, 9, 7, 0].forEach((s, i) => this.tone(freq(s), 0.25, 'triangle', 0.12, i * 0.16)); }

  /** Lookahead music sequencer; call every frame. */
  tick() {
    if (!this.ctx || !this.musicGain || !this.playing) return;
    // Don't try to catch up on beats missed while the music was stopped.
    if (this.nextBeat < this.ctx.currentTime - 0.05) this.nextBeat = this.ctx.currentTime + 0.05;
    const spb = 60 / (118 + this.intensity * 6) / 2; // eighth notes
    const bass = [0, 0, 12, 0, 7, 0, 10, 12];
    const prog = [0, 0, -2, -4];
    while (this.nextBeat < this.ctx.currentTime + 0.15) {
      const when = this.nextBeat - this.ctx.currentTime;
      const step = this.beat % 8;
      const bar = Math.floor(this.beat / 8) % prog.length;
      const root = -12 + prog[bar];
      this.tone(freq(root + bass[step]), spb * 0.9, 'sawtooth', 0.09, when, undefined, this.musicGain);
      if (step % 4 === 0) this.tone(70, 0.18, 'sine', 0.35, when, 35, this.musicGain); // kick
      if (this.intensity >= 1 && step % 2 === 1) this.hiss(0.04, 0.08, 7000, when, this.musicGain); // hats
      if (this.intensity >= 2 && step % 4 === 2) this.hiss(0.12, 0.12, 1500, when, this.musicGain); // snare
      if (this.intensity >= 3) {
        const arp = [12, 16, 19, 24];
        this.tone(freq(root + 12 + arp[step % 4]), spb * 0.6, 'square', 0.035, when, undefined, this.musicGain);
      }
      this.nextBeat += spb;
      this.beat++;
    }
  }
}
