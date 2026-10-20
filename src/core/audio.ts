/** Audio playback with a precise song clock, plus synthesized sound effects. */
export class AudioEngine {
  private static inst: AudioEngine | null = null;
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly music: GainNode;
  readonly sfx: GainNode;
  private noise: AudioBuffer;
  private song: AudioBufferSourceNode | null = null;
  private songStart = 0;
  private pausedAt: number | null = null;
  /** User-tuned extra audio delay in ms (positive = audio heard later). */
  offsetMs = 0;

  static get(): AudioEngine {
    if (!AudioEngine.inst) AudioEngine.inst = new AudioEngine();
    return AudioEngine.inst;
  }

  private constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.music = this.ctx.createGain();
    this.music.connect(this.master);
    this.sfx = this.ctx.createGain();
    this.sfx.gain.value = 0.7;
    this.sfx.connect(this.master);
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  async unlock(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.ctx.decodeAudioData(data.slice(0));
  }

  async load(url: string): Promise<AudioBuffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load ${url}`);
    return this.decode(await res.arrayBuffer());
  }

  /** Audible context time at a performance.now() moment. */
  ctxTimeAt(perfMs: number): number {
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime !== undefined && ts.performanceTime) {
      return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
    }
    const lat = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return this.ctx.currentTime + (perfMs - performance.now()) / 1000 - lat;
  }

  /** Song position (seconds) the player hears at a performance.now() moment. Negative during the lead-in. */
  songTimeAt(perfMs: number): number {
    if (this.pausedAt !== null) return this.pausedAt;
    return this.ctxTimeAt(perfMs) - this.songStart - this.offsetMs / 1000;
  }

  songTime(): number {
    return this.songTimeAt(performance.now());
  }

  /** Start a song after `leadIn` seconds of silence, optionally from `offset` seconds in. */
  playSong(buf: AudioBuffer, leadIn: number, offset = 0): void {
    this.stopSong();
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.music);
    const at = this.ctx.currentTime + leadIn;
    this.songStart = at - offset;
    src.start(at, offset);
    this.song = src;
    this.pausedAt = null;
  }

  async pause(): Promise<void> {
    if (this.pausedAt !== null) return;
    this.pausedAt = this.songTime();
    await this.ctx.suspend();
  }

  async resume(): Promise<void> {
    if (this.pausedAt === null) return;
    await this.ctx.resume();
    this.pausedAt = null;
  }

  get paused(): boolean {
    return this.pausedAt !== null;
  }

  stopSong(): void {
    if (this.song) {
      try {
        this.song.stop();
      } catch {
        /* already stopped */
      }
      this.song.disconnect();
      this.song = null;
    }
    this.pausedAt = null;
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  fadeMusic(to: number, seconds: number): void {
    const g = this.music.gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.setValueAtTime(g.value, this.ctx.currentTime);
    g.linearRampToValueAtTime(to, this.ctx.currentTime + seconds);
  }

  // ---- sound effects -------------------------------------------------------

  private env(node: AudioNode, gain: number, attack: number, decay: number, at = this.ctx.currentTime): GainNode {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    node.connect(g);
    return g;
  }

  private out(node: AudioNode, pan = 0): void {
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    node.connect(p);
    p.connect(this.sfx);
  }

  private noiseSrc(at: number, dur: number): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.start(at, Math.random() * 0.5, dur);
    return s;
  }

  private tone(type: OscillatorType, f0: number, f1: number, at: number, dur: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, at);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), at + dur);
    o.start(at);
    o.stop(at + dur + 0.05);
    return o;
  }

  /** A clean saber slice. `power` 0..1 scales brightness. */
  slice(pan = 0, power = 1): void {
    const t = this.ctx.currentTime;
    const n = this.noiseSrc(t, 0.25);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(5200, t);
    bp.frequency.exponentialRampToValueAtTime(1400, t + 0.16);
    bp.Q.value = 1.4;
    n.connect(bp);
    this.out(this.env(bp, 0.55 * (0.6 + 0.4 * power), 0.004, 0.16), pan);
    this.out(this.env(this.tone('triangle', 2200, 500, t, 0.09), 0.18, 0.002, 0.08), pan);
    this.out(this.env(this.tone('sine', 140, 60, t, 0.12), 0.5, 0.003, 0.11), pan * 0.5);
  }

  badCut(pan = 0): void {
    const t = this.ctx.currentTime;
    const o = this.tone('square', 110, 70, t, 0.2);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    o.connect(lp);
    this.out(this.env(lp, 0.22, 0.005, 0.2), pan);
  }

  miss(pan = 0): void {
    const t = this.ctx.currentTime;
    this.out(this.env(this.tone('sine', 220, 90, t, 0.25), 0.18, 0.01, 0.24), pan);
  }

  bomb(): void {
    const t = this.ctx.currentTime;
    const n = this.noiseSrc(t, 0.9);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3000, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + 0.7);
    n.connect(lp);
    this.out(this.env(lp, 0.9, 0.003, 0.75));
    this.out(this.env(this.tone('sine', 90, 30, t, 0.5), 0.8, 0.003, 0.5));
  }

  wallHit(): void {
    const t = this.ctx.currentTime;
    const n = this.noiseSrc(t, 0.3);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2500;
    n.connect(hp);
    this.out(this.env(hp, 0.12, 0.01, 0.25));
  }

  hover(): void {
    const t = this.ctx.currentTime;
    this.out(this.env(this.tone('sine', 1320, 1320, t, 0.05), 0.06, 0.003, 0.05));
  }

  select(): void {
    const t = this.ctx.currentTime;
    this.out(this.env(this.tone('sine', 660, 660, t, 0.12), 0.18, 0.004, 0.12));
    this.out(this.env(this.tone('sine', 990, 990, t + 0.07, 0.18), 0.18, 0.004, 0.18));
  }

  combo(level: number): void {
    const t = this.ctx.currentTime;
    const base = 440 * Math.pow(2, Math.min(level, 4) / 4);
    [1, 1.25, 1.5, 2].forEach((m, i) => {
      this.out(this.env(this.tone('triangle', base * m, base * m, t + i * 0.05, 0.12), 0.1, 0.004, 0.12));
    });
  }

  beep(high = false): void {
    const t = this.ctx.currentTime;
    const f = high ? 1320 : 880;
    this.out(this.env(this.tone('sine', f, f, t, 0.18), 0.25, 0.004, 0.18));
  }
}
