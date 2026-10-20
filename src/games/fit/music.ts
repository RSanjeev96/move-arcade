/**
 * Song loading for workouts. Decodes bundled or device songs (the same library as Blade Beat) and gets the beat
 * analysis from the shared cache, or computes it in a Web Worker so the UI stays smooth.
 */
import { AudioEngine } from '../../core/audio';
import { analyze, type Analysis } from '../../core/beat';
import { idb } from '../../core/storage';
import type { LoadedSong, SongInfo } from '../blade/songs';

const BASE = import.meta.env.BASE_URL;
const MY_VERSION = 1;

/** A song in a workout's playlist: ready now, or still loading. */
export interface Track {
  info: SongInfo;
  song: LoadedSong | null;
  ready: Promise<LoadedSong | null>;
  /** Loading failed; the playlist skips it. */
  failed?: boolean;
}

async function cached(id: string): Promise<Analysis | null> {
  // Blade Beat's cache (same analyser), then ours.
  const shared = await idb.get<{ v: number; a: Analysis }>('analysis', id);
  if (shared && shared.v >= 3 && shared.a?.beats?.length) return shared.a;
  const mine = await idb.get<{ v: number; a: Analysis }>('analysis', `fit:${id}`);
  if (mine && mine.v === MY_VERSION && mine.a?.beats) return mine.a;
  return null;
}

function analyzeOffThread(buffer: AudioBuffer): Promise<Analysis> {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i).slice());
  const inline = () => analyze(channels, buffer.sampleRate);
  return new Promise((resolve) => {
    let w: Worker;
    try {
      w = new Worker(new URL('./analyze.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve(inline());
      return;
    }
    w.onmessage = (e: MessageEvent<Analysis>) => {
      w.terminate();
      resolve(e.data);
    };
    w.onerror = () => {
      w.terminate();
      resolve(inline());
    };
    w.postMessage({ channels, sr: buffer.sampleRate }, channels.map((c) => c.buffer));
  });
}

export async function loadTrack(info: SongInfo): Promise<LoadedSong> {
  const audio = AudioEngine.get();
  let buffer: AudioBuffer;
  if (info.source === 'device') {
    const rec = await idb.get<{ blob: Blob }>('songs', info.id);
    if (!rec) throw new Error('That song is no longer on this device.');
    buffer = await audio.decode(await rec.blob.arrayBuffer());
  } else {
    buffer = await audio.load(`${BASE}music/${info.file}`);
  }
  let analysis = await cached(info.id);
  if (!analysis) {
    analysis = await analyzeOffThread(buffer);
    await idb.put('analysis', `fit:${info.id}`, { v: MY_VERSION, a: analysis });
  }
  return { info, buffer, analysis };
}
