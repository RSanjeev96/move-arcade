import type { AudioEngine } from '../../core/audio';

/** Where the song's time comes from: a decoded audio buffer or a YouTube player. */
export interface SongClock {
  readonly duration: number;
  /** Start after `leadIn` seconds, optionally from `offset` seconds into the song. */
  start(leadIn: number, offset: number): void;
  /** Song position the player hears now (negative during the lead-in). */
  time(): number;
  /** Song position at a performance.now() moment. */
  timeAt(perfMs: number): number;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): void;
  fadeOut(seconds: number): void;
}

export class BufferClock implements SongClock {
  constructor(
    private audio: AudioEngine,
    private buffer: AudioBuffer,
  ) {}
  get duration(): number {
    return this.buffer.duration;
  }
  start(leadIn: number, offset: number): void {
    this.audio.playSong(this.buffer, leadIn, offset);
  }
  time(): number {
    return this.audio.songTime();
  }
  timeAt(perfMs: number): number {
    return this.audio.songTimeAt(perfMs);
  }
  pause(): Promise<void> {
    return this.audio.pause();
  }
  resume(): Promise<void> {
    return this.audio.resume();
  }
  stop(): void {
    this.audio.stopSong();
  }
  fadeOut(seconds: number): void {
    this.audio.fadeMusic(0, seconds);
  }
}

// ---- YouTube --------------------------------------------------------------------------------

interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(s: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  setVolume(v: number): void;
  getVideoData?: () => { title?: string };
  destroy(): void;
}

interface YTNamespace {
  Player: new (
    el: HTMLElement,
    opts: {
      videoId: string;
      width?: number | string;
      height?: number | string;
      playerVars?: Record<string, number | string>;
      events?: { onReady?: () => void; onStateChange?: (e: { data: number }) => void; onError?: (e: { data: number }) => void };
    },
  ) => YTPlayer;
}

let apiPromise: Promise<YTNamespace> | null = null;

/** Load the official YouTube IFrame Player API once. */
export function loadYouTubeApi(): Promise<YTNamespace> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const w = window as unknown as { YT?: YTNamespace & { loaded?: number }; onYouTubeIframeAPIReady?: () => void };
    if (w.YT?.Player) return resolve(w.YT);
    w.onYouTubeIframeAPIReady = () => resolve(w.YT!);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => reject(new Error('Could not reach YouTube. Check the internet connection.'));
    document.head.appendChild(s);
    setTimeout(() => reject(new Error('YouTube took too long to load.')), 15000);
  });
  return apiPromise;
}

export function parseYouTubeId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.endsWith('youtu.be')) return u.pathname.slice(1, 12) || null;
    if (u.searchParams.get('v')) return u.searchParams.get('v')!.slice(0, 11);
    const m = u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{11})/);
    if (m) return m[1];
  } catch {
    /* not a URL */
  }
  const m = s.match(/([\w-]{11})/);
  return m ? m[1] : null;
}

const PLAYING = 1;

/** A visible YouTube player whose playback position drives the game. */
export class YouTubePlayer {
  private player: YTPlayer | null = null;
  private anchorMedia = 0;
  private anchorPerf = 0;
  private lastRaw = -1;
  playing = false;
  title = '';

  private constructor(readonly el: HTMLElement) {}

  static async create(host: HTMLElement, videoId: string): Promise<YouTubePlayer> {
    const YT = await loadYouTubeApi();
    const wrap = document.createElement('div');
    wrap.className = 'yt-frame';
    const slot = document.createElement('div');
    wrap.appendChild(slot);
    host.appendChild(wrap);
    const yp = new YouTubePlayer(wrap);
    await new Promise<void>((resolve, reject) => {
      yp.player = new YT.Player(slot, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: { playsinline: 1, controls: 0, rel: 0, modestbranding: 1, disablekb: 1, fs: 0, iv_load_policy: 3 },
        events: {
          onReady: () => resolve(),
          onStateChange: (e) => {
            yp.playing = e.data === PLAYING;
            yp.reanchor();
          },
          onError: (e) =>
            reject(new Error(e.data === 101 || e.data === 150 ? 'This video does not allow playing inside other apps. Try another upload of the song.' : 'YouTube could not play this video.')),
        },
      });
    });
    yp.title = yp.player!.getVideoData?.().title ?? '';
    return yp;
  }

  get duration(): number {
    return this.player?.getDuration() ?? 0;
  }

  private reanchor(): void {
    if (!this.player) return;
    this.anchorMedia = this.player.getCurrentTime();
    this.anchorPerf = performance.now();
  }

  /** Smooth media time: YouTube reports positions in steps, so extrapolate between updates. */
  mediaTimeAt(perfMs: number): number {
    if (!this.player) return 0;
    const raw = this.player.getCurrentTime();
    if (raw !== this.lastRaw) {
      this.lastRaw = raw;
      const predicted = this.anchorMedia + (performance.now() - this.anchorPerf) / 1000;
      // Re-anchor when the report drifts from our prediction (seek, buffering, first frames).
      if (!this.playing || Math.abs(predicted - raw) > 0.08) this.reanchor();
      else {
        this.anchorMedia += (raw - predicted) * 0.1;
      }
    }
    if (!this.playing) return this.anchorMedia;
    return this.anchorMedia + (perfMs - this.anchorPerf) / 1000;
  }

  play(): void {
    this.player?.playVideo();
  }
  pause(): void {
    this.player?.pauseVideo();
  }
  seek(s: number): void {
    this.player?.seekTo(s, true);
    this.reanchor();
  }
  setVolume(v: number): void {
    this.player?.setVolume(Math.round(v * 100));
  }
  destroy(): void {
    this.player?.destroy();
    this.player = null;
    this.el.remove();
  }
}

export class YouTubeClock implements SongClock {
  private startPerf = 0;
  private leadIn = 0;
  private started = false;
  private pausedAt: number | null = null;
  private timer = 0;

  constructor(
    private yt: YouTubePlayer,
    private offsetMs: number,
  ) {}

  get duration(): number {
    return this.yt.duration;
  }

  start(leadIn: number, offset: number): void {
    this.leadIn = leadIn;
    this.startPerf = performance.now();
    this.yt.seek(offset);
    this.yt.pause();
    this.timer = window.setTimeout(() => {
      this.started = true;
      this.yt.play();
    }, leadIn * 1000);
  }

  timeAt(perfMs: number): number {
    if (this.pausedAt !== null) return this.pausedAt;
    if (!this.started || !this.yt.playing) {
      const lead = -this.leadIn + (perfMs - this.startPerf) / 1000;
      if (!this.started) return Math.min(lead, 0);
      return this.yt.mediaTimeAt(perfMs) - this.offsetMs / 1000;
    }
    return this.yt.mediaTimeAt(perfMs) - this.offsetMs / 1000;
  }

  time(): number {
    return this.timeAt(performance.now());
  }

  async pause(): Promise<void> {
    this.pausedAt = this.time();
    clearTimeout(this.timer);
    this.yt.pause();
  }

  async resume(): Promise<void> {
    if (this.pausedAt === null) return;
    const at = this.pausedAt;
    this.pausedAt = null;
    if (at < 0) {
      this.start(-at, 0);
      return;
    }
    this.started = true;
    this.yt.play();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.yt.pause();
  }

  fadeOut(seconds: number): void {
    const steps = 10;
    for (let i = 1; i <= steps; i++) setTimeout(() => this.yt.setVolume(1 - i / steps), (seconds * 1000 * i) / steps);
  }
}

/** Build a beat analysis for a song we cannot decode (YouTube): a steady tempo grid with gentle sections. */
export function gridAnalysis(bpm: number, firstBeat: number, duration: number): import('../../core/beat').Analysis {
  const period = 60 / bpm;
  const beats: number[] = [];
  for (let t = firstBeat; t < duration - 1; t += period) if (t >= 0) beats.push(t);
  const fps = 86;
  const env = new Float32Array(Math.ceil(duration * fps) + 1);
  beats.forEach((b, i) => {
    const s = i % 4 === 0 ? 1 : i % 2 === 0 ? 0.8 : 0.65;
    const k = Math.round(b * fps);
    if (k < env.length) env[k] = s;
    const h = Math.round((b + period / 2) * fps);
    if (h < env.length) env[h] = Math.max(env[h], 0.45);
  });
  // Calm and loud stretches every 16 bars so the map breathes and walls get room.
  const energy = beats.map((_, i) => {
    const section = Math.floor(i / 64);
    return section === 0 ? 0.55 : section % 2 ? 0.95 : 0.65;
  });
  const onsets = beats.map((t, i) => ({ t, s: i % 4 === 0 ? 1 : 0.7, low: i % 2 === 0 ? 1 : 0.3 }));
  return { duration, bpm, beats, onsets, energy, env, fps };
}

/** Tempo from tap times (seconds, song clock): least-squares fit of tap index → time. */
export function tapTempo(taps: number[]): { bpm: number; firstBeat: number } | null {
  if (taps.length < 4) return null;
  // Allow skipped taps by snapping intervals to the median.
  const gaps = taps.slice(1).map((t, i) => t - taps[i]);
  const med = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  if (med < 0.25 || med > 1.6) return null;
  const idx: number[] = [0];
  for (let i = 1; i < taps.length; i++) idx.push(idx[i - 1] + Math.max(1, Math.round((taps[i] - taps[i - 1]) / med)));
  const n = taps.length;
  const mx = idx.reduce((a, b) => a + b, 0) / n;
  const my = taps.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (idx[i] - mx) ** 2;
    sxy += (idx[i] - mx) * (taps[i] - my);
  }
  const period = sxy / sxx;
  let bpm = 60 / period;
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  const p = 60 / bpm;
  const intercept = my - (sxy / sxx) * mx;
  let first = intercept % p;
  if (first < 0) first += p;
  return { bpm, firstBeat: first };
}
