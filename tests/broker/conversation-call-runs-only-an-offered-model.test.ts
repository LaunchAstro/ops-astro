// SPDX-License-Identifier: AGPL-3.0-only
//
// A conversation call, and a priced planning reply, run only a model their
// operation's provider offers (CS-7.30, `conversationModelsOf`). The broker
// checks the model it is handed itself, not only the command layer: one not
// offered is refused with no row written and nothing sent. And an answer must
// name the model asked for (the default, when none was chosen): an answer
// from another model is held as unknown liability for a person, never
// settled as if it were the one asked for.

import { beforeAll, expect, it as vitestIt } from 'vitest';
import { replayAdapter } from '../../packages/core-connectors/src/index.ts';
import {
  callModelForPlanning,
  callModelInConversation,
  type Broker,
} from '../../packages/core-custody/src/index.ts';
import { noDatabase, s, world } from './broker-world.ts';
import { ask, local, ownerOf, setCap, usePlanningWorld } from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

usePlanningWorld('offeredmodel');

beforeAll(async () => {
  if (!noDatabase) await setCap(s, 100_000);
});

/** The local route, answers priced at nothing. */
const unpriced = (): Broker => ({
  ...local(s),
  providers: new Map([['replay', { build: replayAdapter, price: () => 0 }]]),
});

/** `base`, with every answer custody brings back naming `model` instead of the one that ran. */
const answeringAs = (base: Broker, model: string): Broker => ({
  ...base,
  custody: {
    ...base.custody,
    dispatch: async (credentialRef, request) => {
      const outcome = await base.custody.dispatch(credentialRef, request);
      if (outcome.kind !== 'answered' || !outcome.outbound.ok) return outcome;
      const body = { ...(JSON.parse(outcome.outbound.body) as object), model };
      return { ...outcome, outbound: { ...outcome.outbound, body: JSON.stringify(body) } };
    },
  },
});

const rowsOf = async (conversationId: string) =>
  await s.db.admin.execute<{ state: string; model_id: string | null }>(
    `select state, model_id from public.model_calls where conversation_id = $1`,
    [conversationId],
  );

const CALLS = [
  ['a conversation call', callModelInConversation],
  ['a priced planning reply', callModelForPlanning],
] as const;

it.each(CALLS)(
  '%s naming a model its provider does not offer is refused, with no row and nothing sent',
  async (_case, calling) => {
    world.provider.mode('answer');
    const before = world.provider.seen.length;
    const request = { ...(await ask(s)), model: 'replay-unoffered' };
    const result = await calling(s.db.app, s.business, ownerOf(s), request, unpriced());
    expect({
      result,
      rows: await rowsOf(request.conversation.id),
      sent: world.provider.seen.length - before,
    }).toEqual({
      result: { ok: false, code: 'FIELD_VALUE_INVALID', callId: null },
      rows: [],
      sent: 0,
    });
  },
);

it.each(CALLS)(
  '%s whose answer names another model than the one asked for is held, never settled',
  async (_case, calling) => {
    world.provider.mode('answer');
    const request = await ask(s);
    const broker = answeringAs(unpriced(), 'replay-other');
    const result = await calling(s.db.app, s.business, ownerOf(s), request, broker);
    expect({ result, rows: await rowsOf(request.conversation.id) }).toMatchObject({
      result: { ok: false, code: 'LIABILITY_UNKNOWN' },
      rows: [{ state: 'liability_unknown', model_id: null }],
    });
  },
);

it('a conversation call naming the offered model is answered by it', async () => {
  world.provider.mode('answer');
  const request = { ...(await ask(s)), model: 'replay-1' };
  const result = await callModelInConversation(
    s.db.app,
    s.business,
    ownerOf(s),
    request,
    unpriced(),
  );
  expect({ result, rows: await rowsOf(request.conversation.id) }).toMatchObject({
    result: { ok: true },
    rows: [{ state: 'settled', model_id: 'replay-1' }],
  });
});
