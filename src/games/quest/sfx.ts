/** Sky Quest sound effects (synthesized with Web Audio) and the looping music track. */
import type { AudioEngine } from '../../core/audio';

export class Sfx {
  private ctx: AudioContext;
  private out: GainNode;
  private noise: AudioBuffer;
  private coinStreak = 0;
  private lastCoin = 0;
  private music: AudioBufferSourceNode | null = null;
  private musicGain: GainNode;

  constructor(private audio: AudioEngine) {
    this.ctx = audio.ctx;
    this.out = this.ctx.createGain();
    this.out.gain.value = 0.9;
    this.out.connect(audio.sfx);
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.55;
    this.musicGain.connect(audio.music);
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  private get now(): number {
    return this.ctx.currentTime;
  }

  private env(gain: number, a: number, d: number, at = this.now, pan = 0): GainNode {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + a);
    g.gain.exponentialRampToValueAtTime(0.0001, at + a + d);
    if (pan) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p);
      p.connect(this.out);
    } else g.connect(this.out);
    return g;
  }

  private osc(type: OscillatorType, f0: number, f1: number, at: number, dur: number, dest: AudioNode): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, at);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), at + dur);
    o.connect(dest);
    o.start(at);
    o.stop(at + dur + 0.05);
    return o;
  }

  private noiseBurst(at: number, dur: number, dest: AudioNode, type: BiquadFilterType, f0: number, f1: number, q = 1): void {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, at);
    f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), at + dur);
    s.connect(f);
    f.connect(dest);
    s.start(at, Math.random() * 0.5, dur + 0.05);
  }

  /** Bright two-note chime; quick successive coins climb in pitch. */
  coin(pan = 0): void {
    const t = this.now;
    this.coinStreak = t - this.lastCoin < 0.45 ? Math.min(this.coinStreak + 1, 10) : 0;
    this.lastCoin = t;
    const base = 1318.5 * Math.pow(2, (this.coinStreak % 6) / 12);
    this.osc('square', base, base, t, 0.06, this.env(0.05, 0.003, 0.06, t, pan));
    this.osc('triangle', base * 1.5, base * 1.5, t + 0.055, 0.22, this.env(0.12, 0.003, 0.24, t + 0.055, pan));
    this.osc('sine', base * 3, base * 3, t + 0.055, 0.12, this.env(0.03, 0.003, 0.12, t + 0.055, pan));
  }

  gem(): void {
    const t = this.now;
    [0, 4, 7, 12, 16, 19, 24].forEach((st, i) => {
      const f = 880 * Math.pow(2, st / 12);
      this.osc('triangle', f, f, t + i * 0.05, 0.3, this.env(0.08, 0.003, 0.3, t + i * 0.05));
    });
  }

  jump(big: boolean): void {
    const t = this.now;
    const g = this.env(big ? 0.22 : 0.16, 0.01, big ? 0.32 : 0.2, t);
    this.noiseBurst(t, big ? 0.35 : 0.22, g, 'bandpass', 600, big ? 3200 : 2200, 1.2);
    this.osc('sine', big ? 260 : 330, big ? 900 : 660, t, big ? 0.22 : 0.14, this.env(0.12, 0.005, big ? 0.22 : 0.14, t));
  }

  double(): void {
    const t = this.now;
    this.noiseBurst(t, 0.3, this.env(0.2, 0.005, 0.3, t), 'bandpass', 900, 4200, 1.5);
    [0, 5, 9].forEach((st, i) => {
      const f = 660 * Math.pow(2, st / 12);
      this.osc('triangle', f, f * 1.05, t + i * 0.035, 0.12, this.env(0.07, 0.003, 0.12, t + i * 0.035));
    });
  }

  land(strength: number): void {
    const t = this.now;
    const k = Math.min(1, strength);
    this.osc('sine', 120, 55, t, 0.12, this.env(0.25 * k + 0.05, 0.003, 0.12, t));
    this.noiseBurst(t, 0.1, this.env(0.08 * k + 0.02, 0.003, 0.1, t), 'lowpass', 900, 200);
  }

  step(): void {
    const t = this.now;
    this.noiseBurst(t, 0.05, this.env(0.035, 0.002, 0.05, t), 'bandpass', 1600, 700, 2);
  }

  shoot(pan = 0, triple = false): void {
    const t = this.now;
    this.osc('square', 1500, 280, t, 0.16, this.env(0.07, 0.002, 0.16, t, pan));
    this.osc('sine', 900, 1800, t, 0.08, this.env(0.08, 0.002, 0.08, t, pan));
    if (triple) this.osc('sawtooth', 2200, 400, t, 0.12, this.env(0.03, 0.002, 0.12, t, pan));
  }

  pop(pan = 0): void {
    const t = this.now;
    this.osc('sine', 500, 1400, t, 0.08, this.env(0.22, 0.002, 0.1, t, pan));
    this.noiseBurst(t, 0.18, this.env(0.12, 0.002, 0.18, t, pan), 'highpass', 2000, 6000);
    [0, 7, 12].forEach((st, i) => {
      const f = 1046 * Math.pow(2, st / 12);
      this.osc('triangle', f, f, t + 0.05 + i * 0.04, 0.1, this.env(0.05, 0.003, 0.1, t + 0.05 + i * 0.04, pan));
    });
  }

  stomp(): void {
    const t = this.now;
    this.osc('sine', 300, 80, t, 0.15, this.env(0.3, 0.002, 0.15, t));
    this.osc('square', 180, 600, t + 0.03, 0.12, this.env(0.05, 0.002, 0.12, t + 0.03));
  }

  bump(): void {
    const t = this.now;
    this.osc('square', 220, 110, t, 0.09, this.env(0.12, 0.002, 0.09, t));
    this.osc('sine', 160, 90, t, 0.12, this.env(0.25, 0.002, 0.12, t));
  }

  crate(): void {
    const t = this.now;
    this.noiseBurst(t, 0.25, this.env(0.3, 0.002, 0.25, t), 'bandpass', 1400, 300, 0.8);
    this.osc('triangle', 180, 70, t, 0.15, this.env(0.2, 0.002, 0.15, t));
  }

  hurt(): void {
    const t = this.now;
    this.osc('sawtooth', 420, 110, t, 0.35, this.env(0.12, 0.004, 0.35, t));
    this.osc('sine', 150, 50, t, 0.3, this.env(0.35, 0.003, 0.3, t));
  }

  fall(): void {
    const t = this.now;
    this.osc('sine', 1200, 180, t, 0.9, this.env(0.12, 0.02, 0.9, t));
  }

  spring(): void {
    const t = this.now;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(900, t + 0.35);
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 26;
    const lg = this.ctx.createGain();
    lg.gain.value = 60;
    lfo.connect(lg);
    lg.connect(o.frequency);
    o.connect(this.env(0.22, 0.004, 0.45, t));
    o.start(t);
    lfo.start(t);
    o.stop(t + 0.5);
    lfo.stop(t + 0.5);
  }

  power(): void {
    const t = this.now;
    [0, 4, 7, 12, 7, 12, 16, 19].forEach((st, i) => {
      const f = 523 * Math.pow(2, st / 12);
      this.osc('square', f, f, t + i * 0.055, 0.08, this.env(0.05, 0.003, 0.09, t + i * 0.055));
      this.osc('triangle', f * 2, f * 2, t + i * 0.055, 0.1, this.env(0.05, 0.003, 0.1, t + i * 0.055));
    });
  }

  heart(): void {
    const t = this.now;
    [0, 4, 7].forEach((st) => {
      const f = 523 * Math.pow(2, st / 12);
      this.osc('triangle', f, f, t, 0.6, this.env(0.08, 0.02, 0.6, t));
    });
  }

  checkpoint(): void {
    const t = this.now;
    [0, 4, 7, 12].forEach((st, i) => {
      const f = 659 * Math.pow(2, st / 12);
      this.osc('triangle', f, f, t + i * 0.08, 0.25, this.env(0.12, 0.004, 0.3, t + i * 0.08));
      this.osc('sine', f * 2, f * 2, t + i * 0.08, 0.2, this.env(0.04, 0.004, 0.2, t + i * 0.08));
    });
  }

  shieldPop(): void {
    const t = this.now;
    this.noiseBurst(t, 0.3, this.env(0.2, 0.002, 0.3, t), 'highpass', 3000, 8000);
    this.osc('sine', 1600, 400, t, 0.25, this.env(0.12, 0.002, 0.25, t));
  }

  beep(high: boolean): void {
    const t = this.now;
    const f = high ? 1046 : 784;
    this.osc('triangle', f, f, t, 0.22, this.env(0.2, 0.004, 0.22, t));
    this.osc('sine', f * 2, f * 2, t, 0.15, this.env(0.05, 0.004, 0.15, t));
  }

  starTick(i: number): void {
    const t = this.now;
    const f = 784 * Math.pow(2, (i * 4) / 12);
    this.osc('triangle', f, f, t, 0.4, this.env(0.18, 0.004, 0.45, t));
    this.osc('sine', f * 2, f * 2, t + 0.02, 0.35, this.env(0.07, 0.004, 0.35, t + 0.02));
    this.noiseBurst(t, 0.3, this.env(0.05, 0.004, 0.3, t), 'highpass', 5000, 9000);
  }

  /** Short synthesized fanfare (used if the rendered one is missing). */
  fanfare(): void {
    const t = this.now;
    const notes: [number, number, number][] = [
      [0, 0, 0.12],
      [4, 0.13, 0.12],
      [7, 0.26, 0.12],
      [12, 0.39, 0.5],
      [9, 0.95, 0.14],
      [12, 1.1, 0.14],
      [16, 1.25, 0.9],
    ];
    for (const [st, at, d] of notes) {
      const f = 523 * Math.pow(2, st / 12);
      this.osc('square', f, f, t + at, d, this.env(0.06, 0.005, d, t + at));
      this.osc('triangle', f, f, t + at, d, this.env(0.12, 0.005, d + 0.2, t + at));
    }
  }

  playMusic(buf: AudioBuffer | undefined, volume: number): void {
    this.stopMusic();
    if (!buf) return;
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.connect(this.musicGain);
    this.musicGain.gain.cancelScheduledValues(this.now);
    this.musicGain.gain.setValueAtTime(0.0001, this.now);
    this.musicGain.gain.exponentialRampToValueAtTime(Math.max(0.001, 0.6 * volume), this.now + 1.2);
    s.start(this.now + 0.05);
    this.music = s;
  }

  /** One-shot track through the music bus (fanfare). */
  playOnce(buf: AudioBuffer | undefined, volume: number): boolean {
    if (!buf) return false;
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = 0.8 * volume;
    s.connect(g);
    g.connect(this.audio.music);
    s.start(this.now + 0.02);
    return true;
  }

  duckMusic(to: number, seconds: number): void {
    const g = this.musicGain.gain;
    g.cancelScheduledValues(this.now);
    g.setValueAtTime(Math.max(0.0001, g.value), this.now);
    g.exponentialRampToValueAtTime(Math.max(0.0001, to), this.now + seconds);
  }

  stopMusic(): void {
    if (this.music) {
      try {
        this.music.stop();
      } catch {
        /* already stopped */
      }
      this.music.disconnect();
      this.music = null;
    }
  }

  dispose(): void {
    this.stopMusic();
    this.out.disconnect();
    this.musicGain.disconnect();
  }
}
