/**
 * Music analysis for beat-mapped games: onset envelope (spectral flux), tempo (autocorrelation)
 * and beat positions (dynamic-programming beat tracker, Ellis 2007).
 */

export interface Onset {
  t: number;
  /** Strength 0..1. */
  s: number;
  /** Share of the onset that is bass (kick drums), 0..1. */
  low: number;
}

export interface Analysis {
  duration: number;
  bpm: number;
  /** Beat times in seconds. */
  beats: number[];
  onsets: Onset[];
  /** Loudness per beat interval, 0..1 (same length as beats). */
  energy: number[];
  /** Onset envelope and its frame rate, for querying strength near a time. */
  env: Float32Array;
  fps: number;
}

const SR = 22050;
const N = 1024;
const HOP = 256;
/** Frames are not padded, so frame i is centred N/2 samples after its start. */
const CENTRE = N / 2 / HOP;

export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  for (let i = 0; i < n; i++) out[i] /= channels.length;
  return out;
}

export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const ratio = from / to;
  const n = Math.floor(x.length / ratio);
  const out = new Float32Array(n);
  const box = Math.max(1, Math.round(ratio));
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    let acc = 0;
    let cnt = 0;
    for (let k = 0; k < box && i0 + k < x.length; k++) {
      acc += x[i0 + k];
      cnt++;
    }
    out[i] = cnt ? acc / cnt : 0;
  }
  return out;
}

class FFT {
  private rev: Uint32Array;
  private cos: Float32Array;
  private sin: Float32Array;
  constructor(private n: number) {
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
      this.rev[i] = r;
    }
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
  }
  /** In-place magnitude spectrum of a real frame; writes n/2+1 magnitudes into `mag`. */
  magnitude(frame: Float32Array, re: Float32Array, im: Float32Array, mag: Float32Array): void {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      re[this.rev[i]] = frame[i];
      im[this.rev[i]] = 0;
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let j = 0; j < half; j++) {
          const k = j * step;
          const a = start + j;
          const b = a + half;
          const tr = re[b] * this.cos[k] - im[b] * this.sin[k];
          const ti = re[b] * this.sin[k] + im[b] * this.cos[k];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    for (let i = 0; i <= n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  }
}

function movingAverage(x: Float32Array, radius: number): Float32Array {
  const out = new Float32Array(x.length);
  let acc = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < x.length; i++) {
    const a = Math.max(0, i - radius);
    const b = Math.min(x.length - 1, i + radius);
    while (hi < b) acc += x[++hi];
    while (lo < a) acc -= x[lo++];
    out[i] = acc / (hi - lo + 1);
  }
  return out;
}

function percentile(values: ArrayLike<number>, p: number): number {
  const arr = Array.from(values).sort((a, b) => a - b);
  if (!arr.length) return 0;
  return arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
}

export function estimateTempo(rawEnv: Float32Array, fps: number): number {
  // Widen peaks so whole-frame lags still line up with fractional beat periods.
  const env = movingAverage(rawEnv, 2);
  const minLag = Math.floor((fps * 60) / 200);
  const maxLag = Math.ceil((fps * 60) / 65);
  const top = Math.min(env.length - 1, maxLag * 2 + 2);
  const r = new Float32Array(top + 1);
  for (let lag = Math.floor(minLag / 2); lag <= top; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < env.length; i++) acc += env[i] * env[i + lag];
    r[lag] = acc / (env.length - lag);
  }
  const at = (x: number): number => {
    const i = Math.floor(x);
    if (i < 0 || i + 1 > top) return 0;
    return r[i] + (r[i + 1] - r[i]) * (x - i);
  };
  // A true beat period is periodic at its double and also has events at its half (the off-beat).
  // Rhythmic patterns at 1.5x or 2/3x the beat lack that half-period support.
  const comb = (lag: number): number => at(lag) + 0.5 * at(lag * 2) + 0.5 * at(lag / 2);
  let best = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag += 0.25) {
    const bpm = (60 * fps) / lag;
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    const score = comb(lag) * w;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  // Refine around the winner on the raw autocorrelation.
  let lag = best;
  let peak = at(best);
  for (let x = best - 0.75; x <= best + 0.75; x += 0.05) {
    if (at(x) > peak) {
      peak = at(x);
      lag = x;
    }
  }
  return (60 * fps) / lag;
}

export function trackBeats(env: Float32Array, fps: number, bpm: number, tightness = 100): number[] {
  const period = (60 * fps) / bpm;
  const n = env.length;
  // Smooth the envelope a little so beats can sit on the onset peak.
  const local = movingAverage(env, Math.max(1, Math.round(period / 32)));
  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  for (let i = 0; i < n; i++) {
    let best = -Infinity;
    let arg = -1;
    for (let j = i - hi; j <= i - lo; j++) {
      if (j < 0) continue;
      const d = Math.log((i - j) / period);
      const s = score[j] - tightness * d * d;
      if (s > best) {
        best = s;
        arg = j;
      }
    }
    score[i] = local[i] + (arg >= 0 ? Math.max(0, best) : 0);
    back[i] = arg >= 0 && best > 0 ? arg : -1;
  }
  let end = n - 1;
  let bestEnd = -Infinity;
  for (let i = Math.max(0, n - Math.round(period * 2)); i < n; i++) {
    if (score[i] > bestEnd) {
      bestEnd = score[i];
      end = i;
    }
  }
  const frames: number[] = [];
  for (let i = end; i >= 0; i = back[i]) {
    frames.push(i);
    if (back[i] < 0) break;
  }
  frames.reverse();
  return frames.map((f) => (f + CENTRE) / fps);
}

export function analyze(channels: Float32Array[], sampleRate: number): Analysis {
  const mono = resample(mixToMono(channels), sampleRate, SR);
  const fps = SR / HOP;
  const frames = Math.max(0, Math.floor((mono.length - N) / HOP) + 1);
  const fft = new FFT(N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const frame = new Float32Array(N);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const mag = new Float32Array(N / 2 + 1);
  let prev = new Float32Array(N / 2 + 1);
  let cur = new Float32Array(N / 2 + 1);
  const flux = new Float32Array(frames);
  const lowFlux = new Float32Array(frames);
  const rms = new Float32Array(frames);
  const lowBins = Math.round(180 / (SR / N));

  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    let e = 0;
    for (let i = 0; i < N; i++) {
      const s = mono[off + i];
      frame[i] = s * win[i];
      e += s * s;
    }
    rms[f] = Math.sqrt(e / N);
    fft.magnitude(frame, re, im, mag);
    let total = 0;
    let low = 0;
    for (let k = 1; k <= N / 2; k++) {
      cur[k] = Math.log1p(100 * mag[k]);
      const d = cur[k] - prev[k];
      if (d > 0) {
        total += d;
        if (k <= lowBins) low += d;
      }
    }
    flux[f] = f === 0 ? 0 : total;
    lowFlux[f] = f === 0 ? 0 : low;
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }

  // Onset envelope: broadband flux plus extra weight on bass, so kicks define the beat rather than hi-hats.
  const avg = movingAverage(flux, Math.round(fps * 0.25));
  const lowAvg = movingAverage(lowFlux, Math.round(fps * 0.25));
  const broad = new Float32Array(frames);
  const lowEnv = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    broad[i] = Math.max(0, flux[i] - avg[i]);
    lowEnv[i] = Math.max(0, lowFlux[i] - lowAvg[i]);
  }
  const broadTop = percentile(broad, 0.99) || 1;
  const lowTop = percentile(lowEnv, 0.99) || 1;
  const env = new Float32Array(frames);
  for (let i = 0; i < frames; i++) env[i] = 0.55 * Math.min(1, broad[i] / broadTop) + Math.min(1, lowEnv[i] / lowTop);
  const top = percentile(env, 0.99) || 1;
  for (let i = 0; i < frames; i++) env[i] = Math.min(1, env[i] / top);

  const duration = mono.length / SR;
  const bpm = frames > fps * 4 ? estimateTempo(env, fps) : 120;
  let beats = frames > fps * 4 ? trackBeats(env, fps, bpm) : [];

  // Onsets: local maxima clearly above their neighbourhood.
  const onsets: Onset[] = [];
  const localMean = movingAverage(env, Math.round(fps * 0.4));
  const minGap = Math.round(fps * 0.07);
  let last = -Infinity;
  for (let i = 3; i < frames - 3; i++) {
    const v = env[i];
    if (v < 0.08 || v < localMean[i] + 0.05) continue;
    let isMax = true;
    for (let k = -3; k <= 3; k++) if (env[i + k] > v) isMax = false;
    if (!isMax) continue;
    if (i - last < minGap) continue;
    last = i;
    onsets.push({ t: (i + CENTRE) / fps, s: v, low: Math.min(1, lowEnv[i] / lowTop) });
  }

  // Drop beats before the music starts and after it ends.
  const loud = percentile(rms, 0.9) || 1;
  const firstSound = (() => {
    for (let i = 0; i < frames; i++) if (rms[i] > loud * 0.12) return (i + CENTRE) / fps;
    return 0;
  })();
  const lastSound = (() => {
    for (let i = frames - 1; i >= 0; i--) if (rms[i] > loud * 0.12) return (i + CENTRE) / fps;
    return duration;
  })();
  beats = beats.filter((b) => b >= firstSound - 0.05 && b <= lastSound);

  const energy: number[] = beats.map((b, i) => {
    const a = Math.max(0, Math.floor(b * fps - CENTRE));
    const z = Math.min(frames, Math.floor((beats[i + 1] ?? b + 60 / bpm) * fps - CENTRE));
    let acc = 0;
    for (let k = a; k < z; k++) acc += rms[k];
    return z > a ? acc / (z - a) : 0;
  });
  const eTop = percentile(energy, 0.95) || 1;
  const smoothE = energy.map((_, i) => {
    let acc = 0;
    let cnt = 0;
    for (let k = i - 2; k <= i + 2; k++) {
      if (k >= 0 && k < energy.length) {
        acc += energy[k];
        cnt++;
      }
    }
    return Math.min(1, acc / cnt / eTop);
  });

  return { duration, bpm, beats, onsets, energy: smoothE, env, fps };
}

/** Peak onset strength within `radius` seconds of t. */
export function strengthNear(a: Pick<Analysis, 'env' | 'fps'>, t: number, radius = 0.04): number {
  const i0 = Math.max(0, Math.floor((t - radius) * a.fps - CENTRE));
  const i1 = Math.min(a.env.length - 1, Math.ceil((t + radius) * a.fps - CENTRE));
  let m = 0;
  for (let i = i0; i <= i1; i++) m = Math.max(m, a.env[i]);
  return m;
}
