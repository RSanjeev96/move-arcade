/**
 * Synthesised tennis sounds on the shared AudioEngine: racket hits (pitch follows pace), bounces, net,
 * shoe squeaks, crowd murmur/applause/"ooh" (pre-rendered buffers), and optional umpire voice calls.
 */
import type { AudioEngine } from '../../core/audio';

export class TennisSounds {
  private ctx: AudioContext;
  private out: GainNode;
  private crowdBus: GainNode;
  private murmur: AudioBufferSourceNode | null = null;
  private murmurGain: GainNode;
  private noise: AudioBuffer;
  private applauseBuf: AudioBuffer | null = null;
  private oohBuf: AudioBuffer | null = null;
  private cheerBuf: AudioBuffer | null = null;
  private voice: SpeechSynthesisVoice | null = null;
  voiceOn = true;
  private lastSqueak = 0;

  constructor(
    private audio: AudioEngine,
    private surface: 'hard' | 'grass',
  ) {
    this.ctx = audio.ctx;
    this.out = this.ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(audio.sfx);
    this.crowdBus = this.ctx.createGain();
    this.crowdBus.gain.value = 0.9;
    this.crowdBus.connect(this.out);
    this.murmurGain = this.ctx.createGain();
    this.murmurGain.gain.value = 0;
    this.murmurGain.connect(this.crowdBus);
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    try {
      const pick = () => {
        const vs = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
        this.voice = vs.find((v) => /GB|UK/i.test(v.lang + v.name)) ?? vs[0] ?? null;
      };
      pick();
      speechSynthesis.addEventListener?.('voiceschanged', pick);
    } catch {
      /* no speech */
    }
  }

  /** Start the crowd murmur (buffers come from the shared bank rendered while loading). */
  async prepare(): Promise<void> {
    const bank = await CrowdBank.get(this.ctx);
    this.applauseBuf = bank.applause;
    this.cheerBuf = bank.cheer;
    this.oohBuf = bank.ooh;
    const src = this.ctx.createBufferSource();
    src.buffer = bank.murmur;
    src.loop = true;
    src.connect(this.murmurGain);
    src.start();
    this.murmur = src;
  }

  setCrowdLevel(v: number): void {
    this.murmurGain.gain.setTargetAtTime(v * 0.22, this.ctx.currentTime, 0.4);
  }

  private play(buf: AudioBuffer | null, gain: number, rate = 1): void {
    if (!buf) return;
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    s.connect(g);
    g.connect(this.crowdBus);
    s.start();
  }

  applause(level: number): void {
    this.play(level > 0.8 ? this.cheerBuf : this.applauseBuf, 0.5 + level * 0.7, 0.94 + Math.random() * 0.12);
  }

  oohs(level = 1): void {
    this.play(this.oohBuf, 0.6 * level, 0.9 + Math.random() * 0.2);
  }

  // ---- one-shots -------------------------------------------------------------------------------------

  private env(node: AudioNode, gain: number, attack: number, decay: number, at = this.ctx.currentTime): GainNode {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    node.connect(g);
    return g;
  }

  private send(node: AudioNode, pan: number): void {
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    node.connect(p);
    p.connect(this.out);
  }

  private noiseSrc(at: number, dur: number): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.start(at, Math.random() * 0.5, dur);
    return s;
  }

  private osc(type: OscillatorType, f0: number, f1: number, at: number, dur: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, at);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), at + dur);
    o.start(at);
    o.stop(at + dur + 0.05);
    return o;
  }

  /** Racket on ball. `pace` 0..1, `near` = the human's shot (louder, centred). */
  hit(pace: number, pan: number, near: boolean, mishit = false): void {
    const t = this.ctx.currentTime;
    const vol = near ? 1 : 0.55;
    const f = 1100 + pace * 1400;
    const n = this.noiseSrc(t, 0.08);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = mishit ? 600 : f;
    bp.Q.value = mishit ? 0.8 : 1.6;
    n.connect(bp);
    this.send(this.env(bp, 0.9 * vol, 0.001, 0.04 + pace * 0.02), pan);
    // Ball compression "pock".
    this.send(this.env(this.osc('sine', 420 + pace * 260, 180, t, 0.07), 0.6 * vol, 0.001, 0.06), pan);
    // String ping.
    if (!mishit) this.send(this.env(this.osc('triangle', 2100 + pace * 900, 1600, t, 0.05), 0.12 * vol, 0.001, 0.05), pan);
    else this.send(this.env(this.osc('square', 180, 90, t, 0.12), 0.18 * vol, 0.002, 0.1), pan);
  }

  bounce(speed: number, pan: number, near: boolean): void {
    const t = this.ctx.currentTime;
    const v = Math.min(1, speed / 25) * (near ? 1 : 0.55);
    const n = this.noiseSrc(t, 0.06);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = this.surface === 'grass' ? 700 : 1500;
    n.connect(lp);
    this.send(this.env(lp, 0.5 * v, 0.001, this.surface === 'grass' ? 0.05 : 0.035), pan);
    this.send(this.env(this.osc('sine', this.surface === 'grass' ? 150 : 230, 90, t, 0.06), 0.45 * v, 0.001, 0.05), pan);
  }

  net(): void {
    const t = this.ctx.currentTime;
    const n = this.noiseSrc(t, 0.25);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500;
    n.connect(lp);
    this.send(this.env(lp, 0.6, 0.004, 0.22), 0);
    this.send(this.env(this.osc('sine', 120, 70, t, 0.15), 0.4, 0.002, 0.14), 0);
  }

  wall(): void {
    const t = this.ctx.currentTime;
    const n = this.noiseSrc(t, 0.12);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    n.connect(lp);
    this.send(this.env(lp, 0.35, 0.002, 0.1), 0);
  }

  /** Shoe squeak (hard court) or soft step (grass). */
  step(speed: number, pan: number): void {
    const now = this.ctx.currentTime;
    if (this.surface === 'hard') {
      if (speed < 2.2 || now - this.lastSqueak < 0.28 || Math.random() > 0.55) return;
      this.lastSqueak = now;
      const o = this.osc('sawtooth', 2600 + Math.random() * 900, 3400 + Math.random() * 800, now, 0.07);
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 3200;
      bp.Q.value = 4;
      o.connect(bp);
      this.send(this.env(bp, 0.05 + speed * 0.008, 0.005, 0.06), pan);
    } else {
      if (speed < 1.2) return;
      const n = this.noiseSrc(now, 0.05);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 400;
      n.connect(lp);
      this.send(this.env(lp, 0.08, 0.003, 0.04), pan);
    }
  }

  /** Line judge / umpire tone. */
  callTone(kind: 'out' | 'fault' | 'let' | 'good'): void {
    const t = this.ctx.currentTime;
    if (kind === 'good') {
      this.send(this.env(this.osc('sine', 880, 880, t, 0.12), 0.12, 0.004, 0.12), 0);
      this.send(this.env(this.osc('sine', 1320, 1320, t + 0.08, 0.16), 0.1, 0.004, 0.16), 0);
      return;
    }
    const f = kind === 'out' ? 520 : kind === 'fault' ? 440 : 660;
    this.send(this.env(this.osc('triangle', f, f * 0.98, t, 0.25), 0.16, 0.005, 0.25), 0);
  }

  /** Spoken call (umpire / line judge), when the device has a voice. */
  say(text: string, opts: { rate?: number; pitch?: number; volume?: number } = {}): void {
    if (!this.voiceOn || !text) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      if (this.voice) u.voice = this.voice;
      u.rate = opts.rate ?? 1.0;
      u.pitch = opts.pitch ?? 0.9;
      u.volume = (opts.volume ?? 0.9) * Math.min(1, this.audio.sfx.gain.value / 0.7);
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch {
      /* ignore */
    }
  }

  stopVoice(): void {
    try {
      speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    this.stopVoice();
    try {
      this.murmur?.stop();
    } catch {
      /* stopped */
    }
    this.murmur?.disconnect();
    this.out.disconnect();
  }
}

/** Pre-rendered crowd sounds, shared by every session (rendered once while the game loads). */
export class CrowdBank {
  private static pending: Promise<CrowdBank> | null = null;

  private constructor(
    readonly applause: AudioBuffer,
    readonly cheer: AudioBuffer,
    readonly ooh: AudioBuffer | null,
    readonly murmur: AudioBuffer,
  ) {}

  static get(ctx: AudioContext): Promise<CrowdBank> {
    CrowdBank.pending ??= CrowdBank.render(ctx);
    return CrowdBank.pending;
  }

  private static async render(ctx: AudioContext): Promise<CrowdBank> {
    const sr = Math.min(ctx.sampleRate, 48000);
    const grains = CrowdBank.clapGrains(sr, 24);
    const applause = CrowdBank.applause(ctx, sr, grains, 3.0, 650);
    await new Promise((r) => setTimeout(r, 0));
    const cheerClaps = CrowdBank.applause(ctx, sr, grains, 3.4, 1000);
    const cheer = await CrowdBank.addVoices(ctx, cheerClaps, sr).catch(() => cheerClaps);
    const ooh = await CrowdBank.ooh(ctx, sr).catch(() => null);
    await new Promise((r) => setTimeout(r, 0));
    const murmur = CrowdBank.murmur(ctx, sr, 6);
    return new CrowdBank(applause, cheer, ooh, murmur);
  }

  /** A handful of short filtered noise bursts reused for every clap. */
  private static clapGrains(sr: number, n: number): Float32Array[] {
    const out: Float32Array[] = [];
    const len = Math.floor(sr * 0.022);
    for (let k = 0; k < n; k++) {
      const g = new Float32Array(len);
      const tone = 0.25 + Math.random() * 0.6;
      const dec = Math.exp(-1 / (sr * (0.0025 + Math.random() * 0.004)));
      let e = 1;
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        lp += (w - lp) * tone;
        g[i] = (w - lp * 0.6) * e;
        e *= dec;
      }
      out.push(g);
    }
    return out;
  }

  private static applause(ctx: BaseAudioContext, sr: number, grains: Float32Array[], dur: number, perSec: number): AudioBuffer {
    const n = Math.floor(sr * dur);
    const buf = ctx.createBuffer(2, n, sr);
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    const claps = Math.floor(perSec * dur);
    const glen = grains[0].length;
    for (let c = 0; c < claps; c++) {
      // Density: quick swell, long tail.
      const t = Math.pow(Math.random(), 1.6);
      const start = Math.floor(t * (n - glen - 1));
      const amp = (0.08 + Math.random() * 0.12) * (1 - t * 0.85) * Math.min(1, t * 12 + 0.2);
      const pan = Math.random();
      const g = grains[(Math.random() * grains.length) | 0];
      const al = amp * (1 - pan);
      const ar = amp * pan;
      for (let i = 0; i < glen; i++) {
        L[start + i] += g[i] * al;
        R[start + i] += g[i] * ar;
      }
    }
    return buf;
  }

  /** Mix a "whoo" crowd layer on top of the claps. */
  private static async addVoices(ctx: BaseAudioContext, claps: AudioBuffer, sr: number): Promise<AudioBuffer> {
    const dur = claps.duration;
    const oc = new OfflineAudioContext(2, claps.length, sr);
    const src = oc.createBufferSource();
    src.buffer = claps;
    src.connect(oc.destination);
    src.start();
    const bus = oc.createGain();
    bus.gain.value = 0.35;
    bus.connect(oc.destination);
    for (let v = 0; v < 16; v++) {
      const o = oc.createOscillator();
      o.type = 'sawtooth';
      const f = 230 + Math.random() * 260;
      const st = Math.random() * 0.35;
      o.frequency.setValueAtTime(f * 0.85, st);
      o.frequency.linearRampToValueAtTime(f * 1.15, st + 0.6);
      o.frequency.linearRampToValueAtTime(f * 0.9, dur);
      const bp = oc.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 700 + Math.random() * 500;
      bp.Q.value = 3;
      const g = oc.createGain();
      g.gain.setValueAtTime(0, st);
      g.gain.linearRampToValueAtTime(0.05, st + 0.3);
      g.gain.exponentialRampToValueAtTime(0.0005, dur);
      const p = oc.createStereoPanner();
      p.pan.value = Math.random() * 2 - 1;
      o.connect(bp);
      bp.connect(g);
      g.connect(p);
      p.connect(bus);
      o.start(st);
    }
    void ctx;
    return oc.startRendering();
  }

  private static murmur(ctx: BaseAudioContext, sr: number, dur: number): AudioBuffer {
    const n = Math.floor(sr * dur);
    const buf = ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let b0 = 0;
      let b1 = 0;
      let am = 0.5;
      let amT = 0.5;
      for (let i = 0; i < n; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.985 * b0 + w * 0.06;
        b1 += (b0 - b1) * 0.2;
        if (i % 2400 === 0) amT = 0.35 + Math.random() * 0.65;
        am += (amT - am) * 0.001;
        d[i] = (b0 - b1 * 0.7) * am * 0.9;
      }
      const f = Math.floor(sr * 0.3);
      for (let i = 0; i < f; i++) {
        const k = i / f;
        d[i] = d[i] * k + d[n - f + i] * (1 - k);
      }
    }
    return buf;
  }

  private static async ooh(ctx: BaseAudioContext, sr: number): Promise<AudioBuffer> {
    void ctx;
    const dur = 1.6;
    const oc = new OfflineAudioContext(2, Math.floor(sr * dur), sr);
    const bus = oc.createGain();
    bus.gain.value = 0.5;
    bus.connect(oc.destination);
    for (let v = 0; v < 24; v++) {
      const o = oc.createOscillator();
      o.type = 'sawtooth';
      const f = 110 + Math.random() * 170;
      o.frequency.setValueAtTime(f * 1.05, 0);
      o.frequency.linearRampToValueAtTime(f * 0.92, dur);
      const f1 = oc.createBiquadFilter();
      f1.type = 'bandpass';
      f1.frequency.value = 330 + Math.random() * 60;
      f1.Q.value = 6;
      const f2 = oc.createBiquadFilter();
      f2.type = 'bandpass';
      f2.frequency.value = 800 + Math.random() * 120;
      f2.Q.value = 8;
      const g = oc.createGain();
      const st = Math.random() * 0.12;
      g.gain.setValueAtTime(0, 0);
      g.gain.linearRampToValueAtTime(0.05 + Math.random() * 0.04, st + 0.25);
      g.gain.exponentialRampToValueAtTime(0.0005, dur);
      const p = oc.createStereoPanner();
      p.pan.value = Math.random() * 2 - 1;
      o.connect(f1);
      o.connect(f2);
      f1.connect(g);
      f2.connect(g);
      g.connect(p);
      p.connect(bus);
      o.start(st);
    }
    return oc.startRendering();
  }
}
