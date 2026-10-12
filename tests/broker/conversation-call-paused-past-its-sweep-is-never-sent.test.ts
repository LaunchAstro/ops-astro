// SPDX-License-Identifier: AGPL-3.0-only
//
// A conversation call, and a priced planning reply, count as in flight under
// their route's ceiling from their row's start until the sweep holds them,
// ten minutes on. A call that reached custody only after that would go out
// beside the one that took its place under the ceiling. Custody is told when
// the row's time ends, so such a call is never sent; nothing happened, so its
// row is released and a planning reply's hold given back.

import { beforeAll, expect, it as vitestIt } from 'vitest';
import { replayAdapter } from '../../packages/core-connectors/src/index.ts';
import {
  callModelForPlanning,
  callModelInConversation,
  type Broker,
} from '../../packages/core-custody/src/index.ts';
import { custodyAhead } from './custody-clock-ahead.ts';
import { noDatabase, s, world } from './broker-world.ts';
import { ask, local, ownerOf, setCap, usePlanningWorld } from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

usePlanningWorld('pastsweep');

const TEN_MINUTES = 10 * 60_000;

beforeAll(async () => {
  if (!noDatabase) await setCap(s, 100_000);
});

/** The local route, answers priced at nothing: a conversation call settles, never held. */
const unpriced = (): Broker => ({
  ...local(s),
  providers: new Map([['replay', { build: replayAdapter, price: () => 0 }]]),
});

it.each([
  ['a conversation call', callModelInConversation],
  ['a priced planning reply', callModelForPlanning],
])(
  '%s that reaches custody ten minutes after its row started reaches no provider and is released',
  async (_case, calling) => {
    world.provider.mode('answer');
    const before = world.provider.seen.length;
    const request = await ask(s);
    const result = await custodyAhead(
      TEN_MINUTES,
      async () => await calling(s.db.app, s.business, ownerOf(s), request, unpriced()),
    );
    const rows = await s.db.admin.execute<{ state: string }>(
      `select state from public.model_calls where conversation_id = $1`,
      [request.conversation.id],
    );
    expect({ result, rows, sent: world.provider.seen.length - before }).toMatchObject({
      result: { ok: false, code: 'CALL_RELEASED' },
      rows: [{ state: 'released' }],
      sent: 0,
    });
  },
);

it('a conversation call that reaches custody inside its time is answered', async () => {
  world.provider.mode('answer');
  const request = await ask(s);
  const result = await custodyAhead(
    TEN_MINUTES - 60_000,
    async () =>
      await callModelInConversation(s.db.app, s.business, ownerOf(s), request, unpriced()),
  );
  expect(result).toMatchObject({ ok: true });
});
