import { analyze, type Analysis } from '../../core/beat';
import { AudioEngine } from '../../core/audio';
import { idb } from '../../core/storage';

export interface SongInfo {
  id: string;
  title: string;
  artist: string;
  source: 'bundled' | 'device';
  file?: string;
  credit?: string;
  colors: [string, string];
  duration?: number;
  bpm?: number;
}

interface DeviceSong {
  id: string;
  title: string;
  added: number;
  blob: Blob;
  duration?: number;
  bpm?: number;
}

const ANALYSIS_VERSION = 3;
const BASE = import.meta.env.BASE_URL;
const PALETTES: [string, string][] = [
  ['#ff2d6a', '#8a3bff'],
  ['#00e5ff', '#3b5bff'],
  ['#ffb000', '#ff2d6a'],
  ['#3bffb4', '#00a3ff'],
  ['#c04bff', '#ff4bd8'],
];

let bundledCache: SongInfo[] | null = null;

async function bundled(): Promise<SongInfo[]> {
  if (bundledCache) return bundledCache;
  try {
    const res = await fetch(`${BASE}music/tracks.json`);
    const list = (await res.json()) as Omit<SongInfo, 'source'>[];
    bundledCache = list.map((s) => ({ ...s, source: 'bundled' as const }));
  } catch {
    bundledCache = [];
  }
  return bundledCache;
}

export async function listSongs(): Promise<SongInfo[]> {
  const device = await idb.all<DeviceSong>('songs');
  const mine: SongInfo[] = device
    .sort((a, b) => b.added - a.added)
    .map((d, i) => ({
      id: d.id,
      title: d.title,
      artist: 'Your song',
      source: 'device',
      colors: PALETTES[i % PALETTES.length],
      duration: d.duration,
      bpm: d.bpm,
    }));
  return [...mine, ...(await bundled())];
}

export async function addDeviceSong(file: File): Promise<SongInfo> {
  const id = `dev-${Date.now().toString(36)}`;
  const title = file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim() || 'My song';
  await idb.put('songs', id, { id, title, added: Date.now(), blob: file } satisfies DeviceSong);
  return { id, title, artist: 'Your song', source: 'device', colors: PALETTES[0] };
}

export async function removeDeviceSong(id: string): Promise<void> {
  await idb.del('songs', id);
  await idb.del('analysis', id);
}

export interface LoadedSong {
  info: SongInfo;
  buffer: AudioBuffer;
  analysis: Analysis;
}

export async function loadSong(info: SongInfo, onStatus: (s: string) => void): Promise<LoadedSong> {
  const audio = AudioEngine.get();
  onStatus('Loading song…');
  let buffer: AudioBuffer;
  if (info.source === 'device') {
    const rec = await idb.get<DeviceSong>('songs', info.id);
    if (!rec) throw new Error('That song is no longer on this device.');
    buffer = await audio.decode(await rec.blob.arrayBuffer());
  } else {
    buffer = await audio.load(`${BASE}music/${info.file}`);
  }
  const cached = await idb.get<{ v: number; a: Analysis }>('analysis', info.id);
  let analysis: Analysis;
  if (cached && cached.v === ANALYSIS_VERSION) {
    analysis = cached.a;
  } else {
    onStatus('Listening to the beat…');
    await new Promise((r) => setTimeout(r, 30));
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    analysis = analyze(channels, buffer.sampleRate);
    await idb.put('analysis', info.id, { v: ANALYSIS_VERSION, a: analysis });
    if (info.source === 'device') {
      const rec = await idb.get<DeviceSong>('songs', info.id);
      if (rec) await idb.put('songs', info.id, { ...rec, duration: analysis.duration, bpm: analysis.bpm });
    }
  }
  return { info, buffer, analysis };
}

export function fmtTime(s?: number): string {
  if (!s) return '–:––';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, '0')}`;
}
