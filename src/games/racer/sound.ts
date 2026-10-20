/** Synthesized race audio: engines with pitch following rpm, tyres, wind, kerbs, crowd and impacts. */

function noiseBuffer(ctx: AudioContext, seconds = 2, brown = false): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = b.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else d[i] = w;
  }
  return b;
}

function shaper(ctx: AudioContext, drive: number): WaveShaperNode {
  const ws = ctx.createWaveShaper();
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  ws.curve = curve;
  ws.oversample = '2x';
  return ws;
}

/** One engine: three oscillators + intake noise through a soft clipper and a throttle-driven low-pass. */
class EngineVoice {
  private oscA: OscillatorNode;
  private oscB: OscillatorNode;
  private oscC: OscillatorNode;
  private noise: AudioBufferSourceNode;
  private nf: BiquadFilterNode;
  private ng: GainNode;
  private lp: BiquadFilterNode;
  readonly out: GainNode;
  private gA: GainNode;
  private gC: GainNode;
  private am: GainNode;
  private amOsc: OscillatorNode;

  constructor(
    private ctx: AudioContext,
    dest: AudioNode,
    private bike: boolean,
    noise: AudioBuffer,
  ) {
    const mix = ctx.createGain();
    const ws = shaper(ctx, bike ? 3.2 : 2.2);
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.Q.value = 1.6;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    // Firing-pulse amplitude modulation gives the engine its "grain".
    this.am = ctx.createGain();
    this.am.gain.value = 0.75;
    this.amOsc = ctx.createOscillator();
    this.amOsc.type = 'sine';
    const amDepth = ctx.createGain();
    amDepth.gain.value = bike ? 0.35 : 0.22;
    this.amOsc.connect(amDepth).connect(this.am.gain);
    mix.connect(ws).connect(this.am).connect(this.lp).connect(this.out).connect(dest);
    const osc = (type: OscillatorType, g: number) => {
      const o = ctx.createOscillator();
      o.type = type;
      const gn = ctx.createGain();
      gn.gain.value = g;
      o.connect(gn).connect(mix);
      o.start();
      return [o, gn] as const;
    };
    [this.oscA, this.gA] = osc('sawtooth', bike ? 0.35 : 0.42);
    [this.oscB] = osc('square', bike ? 0.32 : 0.22);
    [this.oscC, this.gC] = osc('sawtooth', bike ? 0.22 : 0.26);
    this.noise = ctx.createBufferSource();
    this.noise.buffer = noise;
    this.noise.loop = true;
    this.nf = ctx.createBiquadFilter();
    this.nf.type = 'bandpass';
    this.nf.Q.value = 1.2;
    this.ng = ctx.createGain();
    this.ng.gain.value = 0;
    this.noise.connect(this.nf).connect(this.ng).connect(mix);
    this.noise.start();
    this.amOsc.start();
  }

  set(rpm: number, throttle: number, gain: number, cut: number, tc = 0.03): void {
    const t = this.ctx.currentTime;
    const f = (rpm / 60) * (this.bike ? 1.2 : 1.5);
    this.oscA.frequency.setTargetAtTime(f, t, tc);
    this.oscB.frequency.setTargetAtTime(f * 0.5, t, tc);
    this.oscC.frequency.setTargetAtTime(f * 2.005, t, tc);
    this.amOsc.frequency.setTargetAtTime(f * (this.bike ? 0.5 : 0.25), t, tc);
    this.nf.frequency.setTargetAtTime(Math.min(9000, f * 4), t, tc);
    this.ng.gain.setTargetAtTime(0.12 + throttle * 0.35, t, 0.05);
    const cutoff = 500 + f * (1.6 + throttle * 4.5) + throttle * 900;
    this.lp.frequency.setTargetAtTime(Math.min(12000, cutoff), t, 0.04);
    this.gA.gain.setTargetAtTime((this.bike ? 0.35 : 0.42) * (0.55 + throttle * 0.45), t, 0.05);
    this.gC.gain.setTargetAtTime((this.bike ? 0.22 : 0.26) * (0.4 + throttle * 0.6), t, 0.05);
    this.out.gain.setTargetAtTime(gain * (1 - cut * 0.7), t, cut > 0 ? 0.008 : 0.05);
  }

  stop(): void {
    const t = this.ctx.currentTime;
    for (const o of [this.oscA, this.oscB, this.oscC, this.amOsc]) o.stop(t + 0.05);
    this.noise.stop(t + 0.05);
    this.out.disconnect();
  }
}

export interface AudioFrame {
  rpm: number;
  throttle: number;
  /** 0..1 speed fraction. */
  speed: number;
  slip: number;
  kerb: boolean;
  offroad: boolean;
  /** 0..1 closeness to a grandstand. */
  crowd: number;
  /** Nearest opponent engine. */
  pack: { rpm: number; gain: number; pan: number };
  /** 0..1 gear-shift cut. */
  cut: number;
  boost: boolean;
}

export class RaceAudio {
  private bus: GainNode;
  private engine: EngineVoice;
  private pack: EngineVoice;
  private packPan: StereoPannerNode;
  private noise: AudioBuffer;
  private brown: AudioBuffer;
  private loops: AudioBufferSourceNode[] = [];
  private oscs: OscillatorNode[] = [];
  private wind: GainNode;
  private squeal: GainNode;
  private squealOsc: OscillatorNode;
  private rumble: GainNode;
  private offroad: GainNode;
  private crowd: GainNode;
  private crowdLvl = 0;
  private boostG: GainNode;
  private cheer = 0;

  constructor(
    private ctx: AudioContext,
    dest: AudioNode,
    bike: boolean,
  ) {
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.gain.setTargetAtTime(1, ctx.currentTime, 0.4);
    this.bus.connect(dest);
    this.noise = noiseBuffer(ctx, 2);
    this.brown = noiseBuffer(ctx, 3, true);
    this.engine = new EngineVoice(ctx, this.bus, bike, this.noise);
    this.packPan = ctx.createStereoPanner();
    this.packPan.connect(this.bus);
    this.pack = new EngineVoice(ctx, this.packPan, bike, this.noise);

    const loop = (buf: AudioBuffer, filters: BiquadFilterNode[], g: number) => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.loopStart = Math.random();
      let node: AudioNode = s;
      for (const f of filters) node = node.connect(f);
      const gn = ctx.createGain();
      gn.gain.value = g;
      node.connect(gn).connect(this.bus);
      s.start(0, Math.random() * 1.5);
      this.loops.push(s);
      return gn;
    };
    const filt = (type: BiquadFilterType, f: number, q = 0.7) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    this.wind = loop(this.noise, [filt('lowpass', 900), filt('highpass', 120)], 0);
    this.squeal = loop(this.noise, [filt('bandpass', 2600, 5)], 0);
    this.offroad = loop(this.brown, [filt('lowpass', 420)], 0);
    this.crowd = loop(this.noise, [filt('bandpass', 1100, 0.6), filt('lowpass', 2600)], 0);
    this.boostG = loop(this.noise, [filt('bandpass', 5200, 1.5)], 0);
    // Tonal squeal with vibrato.
    this.squealOsc = ctx.createOscillator();
    this.squealOsc.type = 'triangle';
    this.squealOsc.frequency.value = 1150;
    const vib = ctx.createOscillator();
    vib.frequency.value = 7;
    const vibG = ctx.createGain();
    vibG.gain.value = 40;
    vib.connect(vibG).connect(this.squealOsc.frequency);
    const sqG = ctx.createGain();
    sqG.gain.value = 0.35;
    this.squealOsc.connect(sqG).connect(this.squeal);
    this.squealOsc.start();
    vib.start();
    this.oscs.push(this.squealOsc, vib);
    // Kerb rumble: low square buzz.
    const rb = ctx.createOscillator();
    rb.type = 'square';
    rb.frequency.value = 28;
    const rlp = filt('lowpass', 220);
    this.rumble = ctx.createGain();
    this.rumble.gain.value = 0;
    rb.connect(rlp).connect(this.rumble).connect(this.bus);
    rb.start();
    this.oscs.push(rb);
  }

  update(f: AudioFrame): void {
    const t = this.ctx.currentTime;
    this.engine.set(f.rpm, f.throttle, 0.34, f.cut);
    this.pack.set(f.pack.rpm, 0.9, f.pack.gain * 0.22, 0, 0.08);
    this.packPan.pan.setTargetAtTime(Math.max(-1, Math.min(1, f.pack.pan)), t, 0.1);
    this.wind.gain.setTargetAtTime(f.speed * f.speed * 0.32, t, 0.1);
    this.squeal.gain.setTargetAtTime(Math.min(1, f.slip * 1.4) * 0.22, t, 0.05);
    this.rumble.gain.setTargetAtTime(f.kerb ? 0.4 * Math.min(1, f.speed * 3) : 0, t, 0.03);
    this.offroad.gain.setTargetAtTime(f.offroad ? 0.5 * Math.min(1, f.speed * 2.5) : 0, t, 0.05);
    this.cheer = Math.max(0, this.cheer - 0.004);
    this.crowdLvl += (f.crowd - this.crowdLvl) * 0.05;
    this.crowd.gain.setTargetAtTime(0.03 + this.crowdLvl * 0.22 + this.cheer * 0.35, t, 0.2);
    this.boostG.gain.setTargetAtTime(f.boost ? 0.12 : 0, t, 0.1);
  }

  /** Crowd roar (overtakes, finish). */
  roar(amount = 1): void {
    this.cheer = Math.min(1, this.cheer + amount);
  }

  private burst(dur: number, freq: number, type: BiquadFilterType, gain: number, q = 0.8): void {
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.bus);
    s.start(t, Math.random(), dur + 0.05);
  }

  private thump(freq: number, dur: number, gain: number): void {
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.4, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** Gear change: short exhaust crackle (louder on downshifts). */
  shift(up: boolean): void {
    this.burst(up ? 0.07 : 0.12, up ? 1800 : 900, 'bandpass', up ? 0.18 : 0.28, 1.2);
    if (!up) setTimeout(() => this.burst(0.05, 1300, 'bandpass', 0.18, 1.5), 70);
  }

  impact(strength: number): void {
    const k = Math.min(1, strength / 12);
    this.thump(85, 0.25, 0.4 + 0.5 * k);
    this.burst(0.18 + 0.2 * k, 2400, 'highpass', 0.18 + 0.4 * k);
    this.burst(0.3, 600, 'lowpass', 0.3 * k);
  }

  bump(strength: number): void {
    const k = Math.min(1, strength / 8);
    this.thump(120, 0.15, 0.25 + 0.35 * k);
    this.burst(0.1, 1500, 'bandpass', 0.12 + 0.2 * k);
  }

  boost(): void {
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(880, t + 0.5);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    o.connect(lp).connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + 0.75);
    this.burst(0.6, 4000, 'bandpass', 0.25, 0.8);
  }

  light(final: boolean): void {
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = final ? 1320 : 660;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.28, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (final ? 0.5 : 0.22));
    o.connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + 0.6);
  }

  fanfare(win: boolean): void {
    const t0 = this.ctx.currentTime;
    const notes = win ? [523, 659, 784, 1047, 784, 1047] : [440, 554, 659, 880];
    notes.forEach((f, i) => {
      const t = t0 + i * 0.13;
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      o.connect(g).connect(this.bus);
      o.start(t);
      o.stop(t + 0.45);
    });
    this.roar(1);
  }

  /** Fade everything out (finish / quit). */
  fade(seconds: number): void {
    const t = this.ctx.currentTime;
    this.bus.gain.cancelScheduledValues(t);
    this.bus.gain.setValueAtTime(this.bus.gain.value, t);
    this.bus.gain.linearRampToValueAtTime(0, t + seconds);
  }

  stop(): void {
    this.engine.stop();
    this.pack.stop();
    for (const l of this.loops) l.stop();
    for (const o of this.oscs) o.stop();
    this.bus.disconnect();
  }
}
