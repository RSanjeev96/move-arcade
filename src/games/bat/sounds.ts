/**
 * Big Hitter audio: synthesized bat contact (willow "tock" for cricket, wood "crack" for baseball), whooshes,
 * bounces, stumps, gloves; plus a sampled crowd bed, applause and fireworks (CC0, see CREDITS.md).
 */
import type { AudioEngine } from '../../core/audio';

const BASE = `${import.meta.env.BASE_URL}assets/bat/`;

export class BatSounds {
  private ctx: AudioContext;
  private out: GainNode;
  private verb: ConvolverNode;
  private verbIn: GainNode;
  private noise: AudioBuffer;
  private crowdBuf: AudioBuffer | null = null;
  private applauseBuf: AudioBuffer | null = null;
  private fwBufs: AudioBuffer[] = [];
  private crowdSrc: AudioBufferSourceNode | null = null;
  private crowdGain: GainNode;
  private crowdFilter: BiquadFilterNode;
  private crowdLevel = 0.35;
  private live: AudioScheduledSourceNode[] = [];

  constructor(private audio: AudioEngine) {
    this.ctx = audio.ctx;
    this.out = this.ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(audio.sfx);
    // Stadium echo: a short synthetic impulse response.
    this.verb = this.ctx.createConvolver();
    this.verb.buffer = this.impulse(1.6, 2.6);
    this.verbIn = this.ctx.createGain();
    this.verbIn.gain.value = 0.32;
    this.verbIn.connect(this.verb);
    this.verb.connect(this.out);
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.crowdFilter = this.ctx.createBiquadFilter();
    this.crowdFilter.type = 'lowpass';
    this.crowdFilter.frequency.value = 2600;
    this.crowdGain = this.ctx.createGain();
    this.crowdGain.gain.value = 0;
    this.crowdFilter.connect(this.crowdGain);
    this.crowdGain.connect(this.out);
  }

  /** Load the sampled sounds; missing files only cost us the samples, never the game. */
  async load(): Promise<void> {
    const get = async (f: string) => {
      try {
        return await this.audio.load(BASE + f);
      } catch {
        return null;
      }
    };
    const [crowd, applause, f1, f2] = await Promise.all([get('crowd.ogg'), get('applause.ogg'), get('firework1.ogg'), get('firework2.ogg')]);
    this.crowdBuf = crowd;
    this.applauseBuf = applause;
    this.fwBufs = [f1, f2].filter((b): b is AudioBuffer => !!b);
  }

  private impulse(seconds: number, decay: number): AudioBuffer {
    const n = Math.floor(this.ctx.sampleRate * seconds);
    const b = this.ctx.createBuffer(2, n, this.ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < n; i++) {
        const t = i / n;
        // Sparse early reflections, then a smooth tail.
        const early = i < n * 0.08 && Math.random() < 0.004 ? (Math.random() * 2 - 1) * 0.8 : 0;
        d[i] = (early + (Math.random() * 2 - 1) * 0.5 * Math.pow(1 - t, decay)) * (t < 0.01 ? t / 0.01 : 1);
      }
    }
    return b;
  }

  private track(n: AudioScheduledSourceNode): void {
    this.live.push(n);
    n.onended = () => {
      const i = this.live.indexOf(n);
      if (i >= 0) this.live.splice(i, 1);
    };
  }

  private env(node: AudioNode, gain: number, attack: number, decay: number, at: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    node.connect(g);
    return g;
  }

  private send(node: AudioNode, pan = 0, verb = 0): void {
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    node.connect(p);
    p.connect(this.out);
    if (verb > 0) {
      const v = this.ctx.createGain();
      v.gain.value = verb;
      p.connect(v);
      v.connect(this.verbIn);
    }
  }

  private noiseSrc(at: number, dur: number): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.start(at, Math.random() * 0.5, dur + 0.05);
    this.track(s);
    return s;
  }

  private sine(f: number, at: number, dur: number, f1 = f, type: OscillatorType = 'sine'): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, at);
    if (f1 !== f) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), at + dur);
    o.start(at);
    o.stop(at + dur + 0.05);
    this.track(o);
    return o;
  }

  private filtered(src: AudioNode, type: BiquadFilterType, f: number, q = 1): BiquadFilterNode {
    const b = this.ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    src.connect(b);
    return b;
  }

  /** Bat on ball. power 0..1; edge for thin contact; sweet for the middle of the bat. */
  hit(sport: 'cricket' | 'baseball', power: number, edge: boolean, sweet: boolean): void {
    const t = this.ctx.currentTime + 0.005;
    const p = 0.55 + 0.45 * power;
    const verb = sweet ? 0.9 : 0.45;
    if (sport === 'cricket') {
      if (edge) {
        // Thin "tick" off the edge.
        this.send(this.env(this.filtered(this.noiseSrc(t, 0.03), 'bandpass', 4200, 2), 0.5, 0.001, 0.02, t), 0.1, 0.2);
        this.send(this.env(this.sine(2900, t, 0.05), 0.25, 0.001, 0.04, t));
        this.send(this.env(this.sine(4100, t, 0.03), 0.12, 0.001, 0.025, t));
        return;
      }
      // Willow "tock": a short knock with a hollow wooden body.
      this.send(this.env(this.filtered(this.noiseSrc(t, 0.02), 'bandpass', 2600, 1.1), 0.9 * p, 0.0008, 0.012, t), 0, verb * 0.5);
      for (const [f, g, d] of [
        [760, 0.55, 0.07],
        [1260, 0.4, 0.05],
        [2050, 0.22, 0.035],
        [3150, 0.12, 0.022],
      ] as const)
        this.send(this.env(this.sine(f * (sweet ? 0.94 : 1), t, d + 0.02, f * 0.97), g * p, 0.001, d, t), 0, verb);
      this.send(this.env(this.sine(190, t, 0.08, 120), 0.6 * p, 0.002, 0.06, t), 0, verb * 0.3);
    } else {
      // Wood bat "crack": sharp broadband transient plus bright ringing partials.
      this.send(this.env(this.filtered(this.noiseSrc(t, 0.02), 'highpass', 1400, 0.7), 1.0 * p, 0.0005, edge ? 0.01 : 0.014, t), 0, verb * 0.6);
      const partials: [number, number, number][] = edge
        ? [
            [1650, 0.25, 0.03],
            [2700, 0.15, 0.02],
          ]
        : [
            [1120, 0.45, 0.05],
            [2240, 0.35, 0.04],
            [3530, 0.22, 0.028],
            [5100, 0.1, 0.018],
          ];
      for (const [f, g, d] of partials) this.send(this.env(this.sine(f, t, d + 0.02), g * p, 0.0008, d, t), 0, verb);
      this.send(this.env(this.sine(420, t, 0.05, 300), 0.45 * p, 0.001, 0.04, t), 0, verb * 0.4);
      this.send(this.env(this.sine(110, t, 0.09, 70), 0.5 * p, 0.002, 0.07, t));
    }
  }

  /** Bat through the air. */
  whoosh(speed: number, pan = 0): void {
    const t = this.ctx.currentTime;
    const k = Math.min(1, speed / 16);
    const n = this.noiseSrc(t, 0.3);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.6;
    bp.frequency.setValueAtTime(500, t);
    bp.frequency.exponentialRampToValueAtTime(1600 + 1400 * k, t + 0.1);
    bp.frequency.exponentialRampToValueAtTime(600, t + 0.26);
    n.connect(bp);
    this.send(this.env(bp, 0.08 + 0.3 * k, 0.05, 0.2, t), pan);
  }

  bounce(kind: 'pitch' | 'grass' | 'dirt', strength = 1): void {
    const t = this.ctx.currentTime;
    const s = Math.max(0.15, Math.min(1, strength));
    const f = kind === 'pitch' ? 900 : kind === 'dirt' ? 700 : 420;
    this.send(this.env(this.filtered(this.noiseSrc(t, 0.05), 'lowpass', f, 0.8), 0.5 * s, 0.001, 0.04, t));
    this.send(this.env(this.sine(kind === 'pitch' ? 150 : 110, t, 0.06, 80), 0.35 * s, 0.002, 0.05, t));
  }

  /** Ball crashing into the stumps, bails clattering. */
  stumps(): void {
    const t = this.ctx.currentTime;
    for (let i = 0; i < 5; i++) {
      const at = t + i * (0.025 + Math.random() * 0.04);
      const f = 900 + Math.random() * 900;
      this.send(this.env(this.sine(f, at, 0.05, f * 0.9), 0.35 - i * 0.04, 0.001, 0.04, at), (Math.random() - 0.5) * 0.4, 0.4);
      this.send(this.env(this.filtered(this.noiseSrc(at, 0.03), 'bandpass', 2400, 1.5), 0.25, 0.001, 0.02, at));
    }
    this.send(this.env(this.sine(300, t, 0.12, 180), 0.4, 0.002, 0.1, t), 0, 0.5);
  }

  /** Leather into a glove (keeper, catcher's mitt, fielder). */
  glove(loud = 1): void {
    const t = this.ctx.currentTime;
    this.send(this.env(this.filtered(this.noiseSrc(t, 0.04), 'lowpass', 1500, 0.9), 0.7 * loud, 0.0008, 0.03, t), 0, 0.25);
    this.send(this.env(this.sine(240, t, 0.05, 160), 0.5 * loud, 0.001, 0.04, t));
  }

  // ---- crowd -----------------------------------------------------------------------------------

  startCrowd(level = 0.35): void {
    this.stopCrowd();
    if (!this.crowdBuf) return;
    const s = this.ctx.createBufferSource();
    s.buffer = this.crowdBuf;
    s.loop = true;
    s.connect(this.crowdFilter);
    s.start();
    this.crowdSrc = s;
    this.crowdLevel = level;
    const g = this.crowdGain.gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.setValueAtTime(0.0001, this.ctx.currentTime);
    g.linearRampToValueAtTime(level, this.ctx.currentTime + 1.5);
  }

  stopCrowd(): void {
    try {
      this.crowdSrc?.stop();
    } catch {
      /* not started */
    }
    this.crowdSrc?.disconnect();
    this.crowdSrc = null;
  }

  /** Crowd swell: 0..1 (1 = six / home run). */
  roar(k: number): void {
    const t = this.ctx.currentTime;
    const g = this.crowdGain.gain;
    const peak = this.crowdLevel * (1.4 + 2.6 * k);
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(peak, t + 0.25);
    g.setValueAtTime(peak, t + 0.6 + 1.6 * k);
    g.linearRampToValueAtTime(this.crowdLevel, t + 2.5 + 3 * k);
    const f = this.crowdFilter.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(f.value, t);
    f.linearRampToValueAtTime(5200 + 3000 * k, t + 0.25);
    f.linearRampToValueAtTime(2600, t + 3 + 2 * k);
    if (k > 0.35) this.applause(0.35 + 0.65 * k);
  }

  applause(gain: number): void {
    if (!this.applauseBuf) return;
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource();
    s.buffer = this.applauseBuf;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain * 0.55, t + 0.3);
    g.gain.setValueAtTime(gain * 0.55, t + 3);
    g.gain.linearRampToValueAtTime(0.0001, t + 6);
    s.connect(g);
    g.connect(this.out);
    s.start(t, 0, 6.5);
    this.track(s);
  }

  /** A disappointed "ooh" from the crowd (near miss, dropped catch). */
  ooh(k = 1): void {
    const t = this.ctx.currentTime;
    for (let i = 0; i < 4; i++) {
      const n = this.noiseSrc(t, 1.6);
      const f0 = 380 + i * 90 + Math.random() * 40;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 7;
      bp.frequency.setValueAtTime(f0 * 1.15, t);
      bp.frequency.linearRampToValueAtTime(f0, t + 1.2);
      n.connect(bp);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.5 * k, t + 0.18);
      g.gain.linearRampToValueAtTime(0.0001, t + 1.4);
      bp.connect(g);
      this.send(g, (i - 1.5) * 0.3, 0.3);
    }
  }

  firework(delay = 0): void {
    if (!this.fwBufs.length) return;
    const t = this.ctx.currentTime + delay;
    const s = this.ctx.createBufferSource();
    s.buffer = this.fwBufs[Math.floor(Math.random() * this.fwBufs.length)];
    const g = this.ctx.createGain();
    g.gain.value = 0.55;
    s.connect(g);
    this.send(g, (Math.random() - 0.5) * 0.8, 0.5);
    s.start(t);
    this.track(s);
  }

  stopAll(): void {
    this.stopCrowd();
    for (const n of [...this.live]) {
      try {
        n.stop();
      } catch {
        /* done */
      }
    }
    this.live = [];
  }

  dispose(): void {
    this.stopAll();
    this.out.disconnect();
  }
}
