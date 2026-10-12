// SPDX-License-Identifier: AGPL-3.0-only
//
// #1508, option B (owner): the chat path is priced at nothing and refuses
// anything priced above it. The conversation seam reserves nothing, so an
// operation whose priced maximum is above zero is refused before any row is
// written or anything is sent (Sol's proof on #1412, criterion 5, answered
// here as the chat path's design check F1). An operation declared at zero,
// which the catalogue now takes, is sent as before.

import { expect, it } from 'vitest';
import {
  catalogue,
  registerModelOperation,
  REPLAY_COMPOSE,
  replayAdapter,
} from '../../packages/core-connectors/src/index.ts';
import { callModelInConversation } from '../../packages/core-custody/src/index.ts';
import { noDatabase, s, world } from './broker-world.ts';
import { ask, local, ownerOf, usePlanningWorld } from './aw-04-planning-world.ts';

usePlanningWorld('unpricedseam');

const callRows = async (conversationId: string): Promise<number> =>
  (
    await s.db.admin.execute('select id from public.model_calls where conversation_id = $1', [
      conversationId,
    ])
  ).length;

it.skipIf(noDatabase)(
  'refuses an operation that can charge above zero before any row or send',
  async () => {
    const request = await ask(s);
    const broker = local(s);
    expect(broker.operations.get(request.operation)?.maximumMinor).toBeGreaterThan(0);
    const before = world.provider.seen.length;
    const result = await callModelInConversation(s.db.app, s.business, ownerOf(s), request, broker);
    expect(result).toMatchObject({ ok: false, code: 'BUDGET_UNAVAILABLE', callId: null });
    expect(world.provider.seen.length - before).toBe(0);
    expect(await callRows(request.conversation.id)).toBe(0);
  },
);

it.skipIf(noDatabase)('sends an operation declared at zero, holding nothing', async () => {
  const request = await ask(s);
  const free = { ...REPLAY_COMPOSE, maximumMinor: 0 };
  // A provider that charges nothing for it, as Ollama on the M5 does.
  const providers = new Map([['replay', { build: replayAdapter, price: () => 0 }]]);
  const broker = { ...local(s), operations: catalogue([free]), providers };
  const before = world.provider.seen.length;
  const result = await callModelInConversation(s.db.app, s.business, ownerOf(s), request, broker);
  expect(world.provider.seen.length - before).toBe(1);
  expect(result).toMatchObject({ ok: true, reservedMinor: 0, actualMinor: 0 });
  expect(await callRows(request.conversation.id)).toBe(1);
});

it('the catalogue takes a priced maximum of zero, and never a negative one', () => {
  expect(registerModelOperation({ ...REPLAY_COMPOSE, maximumMinor: 0 }).ok).toBe(true);
  expect(registerModelOperation({ ...REPLAY_COMPOSE, maximumMinor: -1 }).ok).toBe(false);
});
