// SPDX-License-Identifier: AGPL-3.0-only
//
// CS-7.30 on the install whose conversation operation is priced (the replay
// stand-in, `OPS_AGENT_PROVIDER` unset, through the API's own broker): the
// picker offers the stand-in's model at its priced maximum, and choosing it
// changes nothing about what is sent. A model chosen in `conversation.start`,
// a choice made by `conversation.set_model` while a message is kept at the
// same instant, and the default after the choice is cleared each answer
// BUDGET_UNAVAILABLE: no provider request, no call row, each person's message
// kept, no reply. A model this install does not run is refused, nothing kept.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CONVERSATION_ANSWER,
  OLLAMA_DEFAULT_MODEL,
  REPLAY_MODEL_WINDOW,
} from '../../packages/core-connectors/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith } from './aw-03-exchange-fixture.ts';
import { createApiFixture, type Answer } from './fixture.ts';
import { pricedReplayInstall, type PricedInstall } from './priced-replay-install-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const STAND_IN = REPLAY_MODEL_WINDOW.model;

const replyOf = (answer: Answer): unknown => (answer.body as Record<string, unknown>)['reply'];

// eslint-disable-next-line max-lines-per-function -- one install, one world and their checks
describe.skipIf(serverUrl === undefined)('a model chosen on a priced install', () => {
  let priced: PricedInstall;
  let w: ConversationWorld;

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', '');
    priced = await pricedReplayInstall();
    const fixture = await createApiFixture('priced_model_choice');
    w = await conversationWorld({ fixture, api: composedWith(fixture, priced.exchange) });
  }, 180_000);

  afterAll(async () => {
    await priced?.stop();
    await w?.drop();
    vi.unstubAllEnvs();
  });

  const nothingSent = async (sentBefore: number): Promise<void> => {
    expect(priced.provider.seen.length - sentBefore).toBe(0);
    expect(
      await w.count(
        'select count(*)::text as n from public.model_calls where conversation_id is not null',
        [],
      ),
    ).toBe(0);
  };

  const roles = async (conversationId: string): Promise<readonly string[]> =>
    (
      await w.fixture.db.admin.execute<{ readonly role: string }>(
        `select role from public.conversation_messages
          where conversation_id = $1 order by created_at, id`,
        [conversationId],
      )
    ).map((row) => row.role);

  const stored = async (conversationId: string): Promise<string | null> =>
    (
      await w.fixture.db.admin.execute<{ readonly model_id: string | null }>(
        'select model_id from public.conversations where id = $1',
        [conversationId],
      )
    )[0]?.model_id ?? null;

  const refusedForBudget = { answered: false, code: 'BUDGET_UNAVAILABLE' };

  // eslint-disable-next-line max-lines-per-function -- one conversation through each way of choosing
  it('offers the stand-in at its priced maximum, and no choice of it is ever sent', async () => {
    const sentBefore = priced.provider.seen.length;
    const offer = await w.as(w.owner, 'conversation.models', {});
    expect(offer.body).toStrictEqual({
      ok: true,
      models: [
        {
          id: STAND_IN,
          provider: 'replay',
          reach: 'local',
          ceilingMinor: CONVERSATION_ANSWER.maximumMinor,
        },
      ],
      chosen: null,
    });
    expect(CONVERSATION_ANSWER.maximumMinor).toBeGreaterThan(0);

    // Chosen before the first question.
    const opened = await w.as(w.owner, 'conversation.start', {
      body: 'What is due today?',
      model: STAND_IN,
    });
    const conversationId = String(detail(opened)['conversationId']);
    expect(replyOf(opened)).toMatchObject(refusedForBudget);
    expect(await stored(conversationId)).toBe(STAND_IN);
    await nothingSent(sentBefore);

    // Chosen again while a message is kept at the same instant.
    const [set, message] = await Promise.all([
      w.as(w.owner, 'conversation.set_model', { conversationId, model: STAND_IN }),
      w.as(w.owner, 'conversation.message', { conversationId, body: 'And this week?' }),
    ]);
    expect(set.status).toBe(200);
    expect(message.status).toBe(200);
    expect(replyOf(message)).toMatchObject(refusedForBudget);
    await nothingSent(sentBefore);

    // Cleared to the default: the same refusal.
    const cleared = await w.as(w.owner, 'conversation.set_model', { conversationId, model: null });
    expect(cleared.status).toBe(200);
    const plain = await w.as(w.owner, 'conversation.message', {
      conversationId,
      body: 'Anything?',
    });
    expect(replyOf(plain)).toMatchObject(refusedForBudget);
    await nothingSent(sentBefore);
    expect(await roles(conversationId)).toStrictEqual(['person', 'person', 'person']);
  }, 60_000);

  it('refuses a model this install does not run, and keeps the choice it had', async () => {
    const sentBefore = priced.provider.seen.length;
    const opened = await w.as(w.owner, 'conversation.start', {
      body: 'Draft the week',
      model: STAND_IN,
    });
    const conversationId = String(detail(opened)['conversationId']);
    const refused = await w.as(w.owner, 'conversation.set_model', {
      conversationId,
      model: OLLAMA_DEFAULT_MODEL,
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: 'FIELD_VALUE_INVALID', names: ['model'] });
    expect(await stored(conversationId)).toBe(STAND_IN);
    await nothingSent(sentBefore);
  }, 60_000);
});
