import { html, mount, nextAction, topbar } from '../../ui/kit';
import type { GameEnv } from '../types';

/** Placeholder until the game is built. */
export default async function open(env: GameEnv): Promise<void> {
  const el = mount(env.root, html(`<div class="screen">${topbar('Coming soon')}<p class="set-note">This game is being built.</p></div>`));
  env.cursor(true);
  await nextAction(el);
}
