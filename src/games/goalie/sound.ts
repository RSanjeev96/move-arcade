/** Stadium sound, all synthesized with Web Audio: a living crowd bed plus match effects. */
import type { AudioEngine } from '../../core/audio';

export class GoalieSound {
  private ctx: AudioContext;
  private fx: GainNode;
  private amb: GainNode;
  private noise: AudioBuffer;
  private applauseBuf: AudioBuffer;
  private drumBuf: AudioBuffer;
  private bed: { src: AudioBufferSourceNode; filters: BiquadFilterNode[]; gains: GainNode[]; master: GainNode } | null = null;
  private excite = 0.2;
  private target = 0.2;
  private chantAt = 0;
  private stopped = false;
  private nodes: AudioNode[] = [];

  constructor(audio: AudioEngine) {
    this.ctx = audio.ctx;
    this.fx = this.ctx.createGain();
    this.fx.gain.value = 1;
    this.fx.connect(audio.sfx);
    this.amb = this.ctx.createGain();
    this.amb.gain.value = 0.9;
    this.amb.connect(audio.music);
    this.noise = this.makeNoise(3);
    this.applauseBuf = this.makeApplause(3.2);
    this.drumBuf = this.makeDrum();
  }

  private makeNoise(seconds: number): AudioBuffer {
    const sr = this.ctx.sampleRate;
    const b = this.ctx.createBuffer(2, Math.floor(sr * seconds), sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return b;
  }

  /** Many hands clapping: short filtered noise grains at random times. */
  private makeApplause(seconds: number): AudioBuffer {
    const sr = this.ctx.sampleRate;
    const n = Math.floor(sr * seconds);
    const b = this.ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      const claps = Math.floor(seconds * 260);
      for (let k = 0; k < claps; k++) {
        const at = Math.floor(Math.random() * (n - sr * 0.03));
        const len = Math.floor(sr * (0.008 + Math.random() * 0.012));
        const amp = 0.08 + Math.random() * 0.12;
        let prev = 0;
        for (let i = 0; i < len; i++) {
          const w = Math.random() * 2 - 1;
          prev = w - prev * 0.6;
          d[at + i] += prev * amp * Math.exp(-i / (len * 0.3));
        }
      }
      // Fade the ends so it can loop.
      for (let i = 0; i < sr * 0.1; i++) {
        d[i] *= i / (sr * 0.1);
        d[n - 1 - i] *= i / (sr * 0.1);
      }
    }
    return b;
  }

  private makeDrum(): AudioBuffer {
    const sr = this.ctx.sampleRate;
    const n = Math.floor(sr * 0.5);
    const b = this.ctx.createBuffer(1, n, sr);
    const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      d[i] = Math.sin(2 * Math.PI * (55 + 60 * Math.exp(-t * 25)) * t) * Math.exp(-t * 7) * 0.9 + (Math.random() * 2 - 1) * Math.exp(-t * 60) * 0.25;
    }
    return b;
  }

  private gain(v: number, at = this.ctx.currentTime): GainNode {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(v, at);
    return g;
  }

  private env(node: AudioNode, peak: number, attack: number, decay: number, at = this.ctx.currentTime, out: AudioNode = this.fx, pan = 0): GainNode {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    node.connect(g);
    if (pan) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p);
      p.connect(out);
    } else g.connect(out);
    return g;
  }

  private noiseSrc(at: number, dur: number, rate = 1): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.playbackRate.value = rate;
    s.start(at, Math.random() * 2, dur);
    return s;
  }

  private osc(type: OscillatorType, f0: number, f1: number, at: number, dur: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, at);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), at + dur);
    o.start(at);
    o.stop(at + dur + 0.05);
    return o;
  }

  private filter(type: BiquadFilterType, f: number, q = 1): BiquadFilterNode {
    const b = this.ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  }

  // ---- crowd bed ----------------------------------------------------------------------

  startCrowd(): void {
    if (this.bed) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const master = this.gain(0.0001);
    master.gain.exponentialRampToValueAtTime(0.5, this.ctx.currentTime + 2.5);
    const specs: [BiquadFilterType, number, number, number][] = [
      ['lowpass', 380, 0.7, 0.55],
      ['bandpass', 820, 0.9, 0.42],
      ['bandpass', 1650, 1.3, 0.22],
      ['bandpass', 3100, 1.6, 0.06],
    ];
    const filters: BiquadFilterNode[] = [];
    const gains: GainNode[] = [];
    for (const [t, f, q, g] of specs) {
      const fl = this.filter(t, f, q);
      const gn = this.gain(g);
      src.connect(fl);
      fl.connect(gn);
      gn.connect(master);
      filters.push(fl);
      gains.push(gn);
    }
    master.connect(this.amb);
    src.start();
    this.bed = { src, filters, gains, master };
    this.nodes.push(src, master);
  }

  /** Overall crowd excitement 0..1 (eases toward it). */
  setExcitement(v: number): void {
    this.target = Math.max(0, Math.min(1, v));
  }

  update(dt: number, idle: boolean): void {
    if (!this.bed || this.stopped) return;
    this.excite += (this.target - this.excite) * Math.min(1, dt * 1.8);
    const e = this.excite;
    const t = this.ctx.currentTime;
    const b = this.bed;
    b.master.gain.setTargetAtTime(0.18 + 0.75 * e, t, 0.15);
    b.filters[1].frequency.setTargetAtTime(760 + 520 * e + Math.sin(t * 0.7) * 40, t, 0.2);
    b.filters[2].frequency.setTargetAtTime(1500 + 900 * e, t, 0.2);
    b.gains[3].gain.setTargetAtTime(0.04 + 0.2 * e, t, 0.2);
    // Slow random swells in the murmur.
    b.gains[1].gain.setTargetAtTime(0.36 + 0.12 * Math.sin(t * 0.43) + 0.08 * Math.sin(t * 1.37), t, 0.3);
    if (idle && t > this.chantAt) {
      this.chantAt = t + 9 + Math.random() * 8;
      if (Math.random() < 0.7) this.chant();
    }
  }

  /** A terrace chant: drum and claps in a rhythm. */
  chant(): void {
    const t0 = this.ctx.currentTime + 0.05;
    const beat = 0.42;
    const pattern = [0, 1, 2, 2.5, 3, 4, 5, 6, 6.5, 7];
    for (const p of pattern) {
      const s = this.ctx.createBufferSource();
      s.buffer = this.drumBuf;
      s.start(t0 + p * beat);
      this.env(s, 0.32, 0.005, 0.4, t0 + p * beat, this.amb);
      const c = this.ctx.createBufferSource();
      c.buffer = this.applauseBuf;
      c.start(t0 + p * beat + 0.02, Math.random() * 2, 0.12);
      const hp = this.filter('highpass', 900);
      c.connect(hp);
      this.env(hp, 0.5, 0.004, 0.1, t0 + p * beat + 0.02, this.amb);
    }
    // Voices chanting along (vowel-like band).
    const n = this.noiseSrc(t0, beat * 8);
    const bp = this.filter('bandpass', 600, 3);
    bp.frequency.setValueAtTime(520, t0);
    for (let i = 0; i < 8; i++) bp.frequency.setValueAtTime(i % 2 ? 680 : 520, t0 + i * beat);
    n.connect(bp);
    this.env(bp, 0.18, 0.4, beat * 7, t0, this.amb);
  }

  /** Big cheer: `who` decides the colour (home cheer or away cheer). */
  roar(power = 1): void {
    const t = this.ctx.currentTime;
    for (const [f, q, g] of [
      [700, 0.8, 0.5],
      [1400, 1.1, 0.35],
      [2600, 1.4, 0.15],
    ] as const) {
      const n = this.noiseSrc(t, 4.5);
      const bp = this.filter('bandpass', f, q);
      bp.frequency.setValueAtTime(f * 0.8, t);
      bp.frequency.exponentialRampToValueAtTime(f * 1.15, t + 0.5);
      bp.frequency.exponentialRampToValueAtTime(f * 0.9, t + 4);
      n.connect(bp);
      this.env(bp, g * power, 0.18, 3.6, t, this.amb);
    }
    this.applause(1.6 * power, 0.9);
    this.target = Math.max(this.target, 0.85 * power);
  }

  applause(gain = 1, delay = 0): void {
    const t = this.ctx.currentTime + delay;
    const s = this.ctx.createBufferSource();
    s.buffer = this.applauseBuf;
    s.loop = true;
    s.start(t);
    s.stop(t + 4);
    this.env(s, 0.55 * gain, 0.3, 3.4, t, this.amb);
  }

  /** "Ooooh" — a near miss. */
  ooh(): void {
    const t = this.ctx.currentTime;
    for (const [f, g] of [
      [420, 0.5],
      [980, 0.22],
    ] as const) {
      const n = this.noiseSrc(t, 2);
      const bp = this.filter('bandpass', f, 5);
      bp.frequency.setValueAtTime(f * 0.85, t);
      bp.frequency.exponentialRampToValueAtTime(f * 1.25, t + 0.45);
      bp.frequency.exponentialRampToValueAtTime(f * 0.8, t + 1.6);
      n.connect(bp);
      this.env(bp, g, 0.12, 1.5, t, this.amb);
    }
  }

  /** Disappointed groan. */
  groan(): void {
    const t = this.ctx.currentTime;
    const n = this.noiseSrc(t, 2.2);
    const bp = this.filter('bandpass', 560, 4);
    bp.frequency.setValueAtTime(620, t);
    bp.frequency.exponentialRampToValueAtTime(330, t + 1.8);
    n.connect(bp);
    this.env(bp, 0.45, 0.1, 1.8, t, this.amb);
  }

  /** Tension rising during the run-up. */
  swell(seconds: number): void {
    this.target = Math.max(this.target, 0.5);
    const t = this.ctx.currentTime;
    const n = this.noiseSrc(t, seconds + 0.6);
    const bp = this.filter('bandpass', 900, 1.2);
    bp.frequency.setValueAtTime(700, t);
    bp.frequency.exponentialRampToValueAtTime(1500, t + seconds);
    n.connect(bp);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.28, t + seconds);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds + 0.5);
    bp.connect(g);
    g.connect(this.amb);
  }

  // ---- effects -------------------------------------------------------------------------------

  whistle(kind: 'short' | 'long' | 'final' = 'short'): void {
    const blasts = kind === 'final' ? [0.35, 0.35, 1.1] : [kind === 'long' ? 0.8 : 0.28];
    let t = this.ctx.currentTime + 0.02;
    for (const d of blasts) {
      const mix = this.ctx.createGain();
      mix.gain.value = 0.5;
      const o1 = this.osc('sine', 2950, 2950, t, d);
      const o2 = this.osc('sine', 3180, 3180, t, d);
      const am = this.ctx.createGain();
      am.gain.value = 0.6;
      const lfo = this.osc('square', 32, 32, t, d);
      const lg = this.ctx.createGain();
      lg.gain.value = 0.4;
      lfo.connect(lg);
      lg.connect(am.gain);
      o1.connect(am);
      o2.connect(am);
      am.connect(mix);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.32, t + 0.02);
      g.gain.setValueAtTime(0.32, t + d - 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      mix.connect(g);
      g.connect(this.fx);
      t += d + 0.12;
    }
  }

  kick(power = 1, pan = 0): void {
    const t = this.ctx.currentTime;
    this.env(this.osc('sine', 150, 48, t, 0.16), 0.9 * power, 0.003, 0.15, t, this.fx, pan * 0.5);
    const n = this.noiseSrc(t, 0.06);
    const bp = this.filter('bandpass', 1400, 1.2);
    n.connect(bp);
    this.env(bp, 0.6 * power, 0.001, 0.05, t, this.fx, pan * 0.5);
    const c = this.noiseSrc(t, 0.02);
    const hp = this.filter('highpass', 3500);
    c.connect(hp);
    this.env(hp, 0.25, 0.001, 0.015, t, this.fx, pan * 0.5);
  }

  /** The ball flying past/at you: a rising whoosh lasting `dur` seconds. */
  whoosh(dur: number, pan = 0, power = 1): void {
    const t = this.ctx.currentTime;
    const n = this.noiseSrc(t, dur + 0.3);
    const bp = this.filter('bandpass', 500, 1.6);
    bp.frequency.setValueAtTime(380, t);
    bp.frequency.exponentialRampToValueAtTime(2600, t + dur);
    n.connect(bp);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35 * power, t + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.18);
    bp.connect(g);
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p);
    p.connect(this.fx);
  }

  glove(strength = 1, pan = 0): void {
    const t = this.ctx.currentTime;
    const n = this.noiseSrc(t, 0.08);
    const hp = this.filter('bandpass', 1900, 0.8);
    n.connect(hp);
    this.env(hp, 0.9 * strength, 0.001, 0.06, t, this.fx, pan);
    this.env(this.osc('sine', 130, 70, t, 0.1), 0.7 * strength, 0.002, 0.09, t, this.fx, pan);
  }

  catchBall(pan = 0): void {
    const t = this.ctx.currentTime;
    this.env(this.osc('sine', 100, 55, t, 0.18), 1.0, 0.002, 0.16, t, this.fx, pan);
    const n = this.noiseSrc(t, 0.14);
    const lp = this.filter('lowpass', 1300);
    n.connect(lp);
    this.env(lp, 0.8, 0.002, 0.12, t, this.fx, pan);
  }

  net(strength = 1, pan = 0): void {
    const t = this.ctx.currentTime;
    const n = this.noiseSrc(t, 0.9);
    const bp = this.filter('bandpass', 2200, 0.7);
    bp.frequency.setValueAtTime(3200, t);
    bp.frequency.exponentialRampToValueAtTime(900, t + 0.6);
    n.connect(bp);
    this.env(bp, 0.55 * strength, 0.01, 0.7, t, this.fx, pan);
    const r = this.noiseSrc(t + 0.05, 0.6, 0.5);
    const hp = this.filter('highpass', 4500);
    r.connect(hp);
    this.env(hp, 0.2 * strength, 0.02, 0.5, t + 0.05, this.fx, pan);
    this.env(this.osc('sine', 90, 60, t, 0.12), 0.35 * strength, 0.003, 0.1, t, this.fx, pan);
  }

  post(pan = 0): void {
    const t = this.ctx.currentTime;
    for (const [f, d, g] of [
      [392, 1.2, 0.5],
      [1032, 0.7, 0.32],
      [1705, 0.5, 0.22],
      [2680, 0.3, 0.14],
    ] as const)
      this.env(this.osc('sine', f, f * 0.995, t, d), g, 0.001, d, t, this.fx, pan);
    const n = this.noiseSrc(t, 0.03);
    n.connect(this.filter('highpass', 2000));
    this.env(n, 0.4, 0.001, 0.025, t, this.fx, pan);
  }

  bounce(speed: number, pan = 0): void {
    const t = this.ctx.currentTime;
    const g = Math.min(0.6, speed / 12);
    this.env(this.osc('sine', 120, 60, t, 0.09), g, 0.002, 0.08, t, this.fx, pan);
  }

  boom(): void {
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource();
    s.buffer = this.drumBuf;
    s.start(t);
    this.env(s, 0.8, 0.003, 0.45, t, this.fx);
  }

  tick(high = false): void {
    const t = this.ctx.currentTime;
    const f = high ? 1320 : 880;
    this.env(this.osc('sine', f, f, t, 0.12), 0.22, 0.003, 0.12, t, this.fx);
  }

  stop(): void {
    this.stopped = true;
    const t = this.ctx.currentTime;
    if (this.bed) {
      this.bed.master.gain.cancelScheduledValues(t);
      this.bed.master.gain.setValueAtTime(this.bed.master.gain.value, t);
      this.bed.master.gain.linearRampToValueAtTime(0, t + 0.3);
      const src = this.bed.src;
      setTimeout(() => {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
      }, 400);
    }
    setTimeout(() => {
      this.fx.disconnect();
      this.amb.disconnect();
      this.nodes.forEach((n) => n.disconnect());
    }, 500);
  }
}
