// SPDX-License-Identifier: AGPL-3.0-only
//
// An answer that reaches the side panel's call only after the sweep has held
// that call (the server was paused, or the model took too long) settles
// nothing: the call stays held at nothing, no amount is recorded, no reply is
// kept, and the person is told the answer did not finish, never shown it as a
// success. Unpaused, the same answer settles at nothing and is kept.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sweepModelCalls } from '../../packages/core-custody/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith } from './aw-03-exchange-fixture.ts';
import { createApiFixture } from './fixture.ts';
import {
  ollamaBroker,
  standInOllama,
  streamedLines,
  type StandIn,
} from './ollama-stand-in-fixture.ts';
import { sendStreaming } from './streamed-reply-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const WORDS = ['Two ', 'tasks ', 'are ', 'due ', 'today.'];

// oxlint-disable-next-line max-lines-per-function -- one stand-in, one broker and one world
describe.skipIf(serverUrl === undefined)('an answer that comes after its call was held', () => {
  let ollama: StandIn;
  let broker: Awaited<ReturnType<typeof ollamaBroker>>;
  let w: ConversationWorld;

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    ollama = await standInOllama();
    broker = await ollamaBroker(ollama.origin, 'none');
    const fixture = await createApiFixture('answer_after_hold');
    w = await conversationWorld({ fixture, api: composedWith(fixture, broker.exchange) });
  }, 180_000);

  afterAll(async () => {
    await broker?.stop();
    await ollama?.close();
    await w?.drop();
    vi.unstubAllEnvs();
  });

  const calls = async (conversationId: string) =>
    await w.fixture.db.admin.execute<Record<string, unknown>>(
      `select state, actual_minor::int as actual_minor, completed_at is not null as completed
         from public.model_calls where conversation_id = $1 order by started_at`,
      [conversationId],
    );

  const agentReplies = async (conversationId: string): Promise<number> =>
    await w.count(
      `select count(*)::text as n from public.conversation_messages
        where conversation_id = $1 and role = 'agent'`,
      [conversationId],
    );

  /** The sweep, run as the worker runs it, after the call has outlived its ten minutes. */
  async function sweepHolds(conversationId: string): Promise<void> {
    await w.fixture.db.admin.execute(
      `update public.model_calls
          set accepted_at = accepted_at - interval '11 minutes',
              started_at = started_at - interval '11 minutes'
        where conversation_id = $1 and state = 'dispatched'`,
      [conversationId],
    );
    const swept = await w.fixture.db.app.withBusiness(
      w.fixture.business,
      async (tx) => await sweepModelCalls(tx),
    );
    expect(swept.held).toBe(1);
  }

  it('settles nothing, keeps no reply, and its last event says the answer did not finish', async () => {
    ollama.shut();
    const asked = ollama.seen.length;
    // Not awaited: the answer is on its way while the sweep runs.
    const sending = sendStreaming(w.api, w.owner, 'conversation.start', {
      body: 'What is due today?',
    });
    await ollama.arrived(asked + 1);
    const [row] = await w.fixture.db.admin.execute<{ readonly conversation_id: string }>(
      `select conversation_id from public.model_calls where state = 'dispatched'`,
    );
    const conversationId = String(row?.conversation_id);
    await sweepHolds(conversationId);
    ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS) });
    ollama.open();
    const events = await (await sending).rest();
    expect(await calls(conversationId)).toEqual([
      { state: 'liability_unknown', actual_minor: null, completed: false },
    ]);
    expect(await agentReplies(conversationId)).toBe(0);
    const outcome = events.at(-1);
    expect(outcome?.event).toBe('outcome');
    const body = JSON.parse(outcome?.data ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({ reply: { answered: false, code: 'DECISION_STALE' } });
    expect(String((body['reply'] as Record<string, unknown>)['words'])).toContain('did not finish');
  }, 60_000);

  it('unpaused, the same answer settles at nothing and is kept', async () => {
    ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS) });
    const opened = await w.as(w.owner, 'conversation.start', { body: 'What is due?' });
    const conversationId = String(detail(opened)['conversationId']);
    expect(opened.body).toMatchObject({
      reply: { answered: true, body: 'Two tasks are due today.' },
    });
    expect(await calls(conversationId)).toEqual([
      { state: 'settled', actual_minor: 0, completed: true },
    ]);
    expect(await agentReplies(conversationId)).toBe(1);
  }, 60_000);
});
