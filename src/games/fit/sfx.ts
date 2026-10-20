/** Dance Fit sounds (synthesised through the shared SFX bus) and an optional spoken coach. */
import type { AudioEngine } from '../../core/audio';
import type { Rating } from './score';

export class FitSfx {
  constructor(private audio: AudioEngine) {}

  private get ctx(): AudioContext {
    return this.audio.ctx;
  }

  private note(freq: number, at: number, dur: number, gain: number, type: OscillatorType = 'sine', pan = 0): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, at);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    o.connect(g).connect(p).connect(this.audio.sfx);
    o.start(at);
    o.stop(at + dur + 0.05);
  }

  private noise(at: number, dur: number, gain: number, freq: number, q = 1, type: BiquadFilterType = 'bandpass'): void {
    const ctx = this.ctx;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    s.connect(f).connect(g).connect(this.audio.sfx);
    s.start(at);
  }

  rating(r: Rating, combo: number): void {
    const t = this.ctx.currentTime;
    const lift = Math.pow(2, Math.min(combo, 24) / 48);
    if (r === 'perfect') {
      [1046.5, 1318.5, 1568, 2093].forEach((f, i) => this.note(f * lift, t + i * 0.045, 0.28, 0.09, i % 2 ? 'triangle' : 'sine'));
      this.noise(t, 0.18, 0.05, 7000, 0.8, 'highpass');
    } else if (r === 'great') {
      [880, 1318.5].forEach((f, i) => this.note(f * lift, t + i * 0.05, 0.22, 0.08, 'triangle'));
    } else if (r === 'ok') {
      this.note(660, t, 0.16, 0.06, 'sine');
    } else {
      this.note(196, t, 0.18, 0.05, 'sine');
    }
  }

  rep(): void {
    const t = this.ctx.currentTime;
    this.note(1760, t, 0.06, 0.08, 'square');
    this.note(2637, t + 0.03, 0.08, 0.05, 'sine');
  }

  /** Referee-style whistle for interval starts/ends. */
  whistle(long = false): void {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dur = long ? 0.7 : 0.35;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(2900, t);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 38;
    const lg = ctx.createGain();
    lg.gain.value = 140;
    lfo.connect(lg).connect(o.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
    g.gain.setValueAtTime(0.12, t + dur - 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.audio.sfx);
    o.start(t);
    lfo.start(t);
    o.stop(t + dur + 0.05);
    lfo.stop(t + dur + 0.05);
  }

  tick(high = false): void {
    this.audio.beep(high);
  }

  /** A swell of synthetic applause. */
  cheer(): void {
    const t = this.ctx.currentTime;
    for (let i = 0; i < 46; i++) {
      const at = t + Math.random() * 1.8;
      this.noise(at, 0.05 + Math.random() * 0.05, 0.05 + Math.random() * 0.05, 1500 + Math.random() * 2500, 1.2);
    }
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.note(f, t + i * 0.09, 0.6, 0.07, 'triangle'));
  }

  /** Soft whoosh for move changes. */
  swoosh(): void {
    const t = this.ctx.currentTime;
    this.noise(t, 0.35, 0.05, 1200, 0.7);
  }
}

/** Short spoken cues through the Web Speech API, when available. */
export class Voice {
  private last = 0;
  private synth: SpeechSynthesis | null = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
  private voice: SpeechSynthesisVoice | null = null;

  constructor(public enabled: boolean) {
    if (!this.synth) return;
    const pick = () => {
      const vs = this.synth!.getVoices();
      this.voice = vs.find((v) => /en[-_](US|GB)/i.test(v.lang) && /female|samantha|google/i.test(v.name)) ?? vs.find((v) => /^en/i.test(v.lang)) ?? null;
    };
    pick();
    this.synth.addEventListener?.('voiceschanged', pick);
  }

  say(text: string, priority = false): void {
    if (!this.enabled || !this.synth) return;
    const now = performance.now();
    if (!priority && now - this.last < 2500) return;
    this.last = now;
    try {
      if (priority) this.synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (this.voice) u.voice = this.voice;
      u.rate = 1.05;
      u.pitch = 1.05;
      u.volume = 0.9;
      this.synth.speak(u);
    } catch {
      /* speech unavailable */
    }
  }

  pause(): void {
    try {
      this.synth?.cancel();
    } catch {
      /* ignore */
    }
  }
}
