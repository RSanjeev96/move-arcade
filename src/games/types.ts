import type { AudioEngine } from '../core/audio';
import type { BodyTracker } from '../core/body';
import type { Settings } from '../core/settings';
import type { PoseSource } from '../core/types';

/** Everything a game needs from the app. */
export interface GameEnv {
  /** Full-screen element the game owns until open() resolves. Replace its children freely. */
  root: HTMLElement;
  pose: PoseSource;
  body: BodyTracker;
  audio: AudioEngine;
  settings: Settings;
  /** True when there is no camera: `pose` is a SimPose and the game should drive it with a bot. */
  demo: boolean;
  /** URL parameters, for tests: autoplay=1 skips menus, plus game-specific ones (mode, track, seek…). */
  params: URLSearchParams;
  /** Show (menus) or hide (gameplay) the hand cursor. */
  cursor(on: boolean): void;
}

export interface GameInfo {
  id: string;
  name: string;
  desc: string;
  tag: string;
  /** Tile CSS class (gradient), see styles.css .t-* */
  cls: string;
}

/** A game module's default export: runs its own menus, play and results; resolves to go back home. */
export type OpenGame = (env: GameEnv) => Promise<void>;
