import { ICONS } from '../icons';
import type { GameInfo, OpenGame } from './types';

export interface GameEntry extends GameInfo {
  icon: string;
  /** Shown as playable on the home screen. */
  ready: boolean;
  load: () => Promise<{ default: OpenGame }>;
}

export const GAMES: GameEntry[] = [
  { id: 'blade', name: 'Blade Beat', desc: 'Slice blocks to the music', tag: 'Rhythm', cls: 't-blade', icon: ICONS.blade, ready: true, load: () => import('./blade') },
  { id: 'racer', name: 'Grand Prix', desc: 'F1 steering or MotoGP lean', tag: 'Racing', cls: 't-racer', icon: ICONS.wheel, ready: true, load: () => import('./racer') },
  { id: 'goalie', name: 'Goalkeeper', desc: 'Dive and save penalties', tag: 'Sports', cls: 't-goalie', icon: ICONS.glove, ready: false, load: () => import('./goalie') },
  { id: 'bat', name: 'Big Hitter', desc: 'Cricket and baseball batting', tag: 'Sports', cls: 't-bat', icon: ICONS.bat, ready: false, load: () => import('./bat') },
  { id: 'tennis', name: 'Centre Court', desc: 'Swing and rally', tag: 'Sports', cls: 't-tennis', icon: ICONS.racket, ready: false, load: () => import('./tennis') },
  { id: 'fit', name: 'Dance Fit', desc: 'Workouts with a weekly plan', tag: 'Fitness', cls: 't-fit', icon: ICONS.fit, ready: false, load: () => import('./fit') },
  { id: 'quest', name: 'Sky Quest', desc: 'First-person jump adventure', tag: 'Adventure', cls: 't-quest', icon: ICONS.mountain, ready: false, load: () => import('./quest') },
];
