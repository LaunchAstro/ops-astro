// SPDX-License-Identifier: AGPL-3.0-only
//
// A priced planning reply sends the model its conversation chose (CS-7.30),
// as the unpriced conversation call does, rather than leaving it to the
// adapter's default. The choice is the provider's one offered model: one it
// does not offer is refused before any send.

import { expect, it as vitestIt } from 'vitest';
import { REPLAY_MODEL_WINDOW, replayAdapter } from '../../packages/core-connectors/src/index.ts';
import { callModelForPlanning, type Broker } from '../../packages/core-custody/src/index.ts';
import { noDatabase, s, world } from './broker-world.ts';
import { ask, local, ownerOf, setCap, usePlanningWorld } from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

usePlanningWorld('planmodel');

it('a priced planning reply hands the chosen model to the adapter and sends it', async () => {
  await setCap(s, 100_000);
  world.provider.mode('answer');
  const handed: (string | undefined)[] = [];
  const build: typeof replayAdapter = (values, id, model) => {
    handed.push(model);
    return replayAdapter(values, id, model);
  };
  const broker = local(s);
  const replay = broker.providers.get('replay');
  if (replay === undefined) throw new Error('the local broker has no replay adapter');
  const capturing: Broker = { ...broker, providers: new Map([['replay', { ...replay, build }]]) };
  const sent = world.provider.seen.length;
  const result = await callModelForPlanning(
    s.db.app,
    s.business,
    ownerOf(s),
    { ...(await ask(s)), model: REPLAY_MODEL_WINDOW.model },
    capturing,
  );
  expect(result).toMatchObject({ ok: true });
  expect(handed).toStrictEqual([REPLAY_MODEL_WINDOW.model]);
  const asked = world.provider.seen.slice(sent).map((seen) => JSON.parse(seen.body) as object);
  expect(asked).toMatchObject([{ model: REPLAY_MODEL_WINDOW.model }]);
});
