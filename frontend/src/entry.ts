import { defineApp } from '@augur/mfe-sdk/sdk3';
import manifest from '../../manifest.json';
import type { Home } from '../../service/src/api-types.js';
import { API, card, floorFacts, home, nothingOpen, why, type Asked } from './screen.js';

/**
 * What the shell runs in Artifacts' worker (the manifest's `frontend.entry`): `start(ctx)`, once, with
 * the person, the floor and the calls the bridge carries. The shell draws the app bar, the rail (Home,
 * Library, Shared with you, From below) and the About panel from the manifest; Artifacts fills the
 * screen, its pane's title and its About sections. A new floor starts the worker again.
 */
export default defineApp((ctx) => {
  let asked: Asked = { kind: 'asking' };
  const onCard = ctx.surface === 'card';
  const draw = () =>
    onCard ? ctx.frame.card.render(card(asked)) : ctx.frame.screen.render(home(asked, { retry: () => void load(), open: (item) => ctx.navigate(item.path) }));

  // Through the gateway, which adds the person's token, the floor and the app: the worker never sees them.
  const load = async () => {
    asked = { kind: 'asking' };
    draw();
    try {
      const res = await ctx.fetch(`${API}/home`);
      asked = res.ok ? { kind: 'answered', home: (await res.json()) as Home } : { kind: 'failed', why: await why(res) };
    } catch (err) {
      asked = { kind: 'failed', why: (err as Error).message };
    }
    draw();
  };

  if (onCard) return void load();
  ctx.frame.set({ title: 'Home' });
  for (const section of manifest.contributes.about) {
    ctx.frame.about(section.id).render(section.id === 'place' ? floorFacts(ctx) : nothingOpen(section.label));
  }
  void load();
});
