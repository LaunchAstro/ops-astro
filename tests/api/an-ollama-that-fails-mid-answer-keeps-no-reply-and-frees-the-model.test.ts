// SPDX-License-Identifier: AGPL-3.0-only
//
// Ollama failing under the side panel, through the API's own composition root
// on `OPS_AGENT_PROVIDER=ollama`: an answer of 500, and a socket closed
// halfway through a 200. Either way the model may have run, so the call is
// held as unknown with nothing held against it (it cost nothing), the
// person is answered in fixed words that echo nothing Ollama said, and no
// reply is kept. The held call is no longer in flight: the business's one
// Ollama call at a time is free again, so the next question is answered, and
// the same question asked again is too. A 400 proves nothing ran: released.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith } from './aw-03-exchange-fixture.ts';
import { createApiFixture } from './fixture.ts';
import {
  chatAnswer,
  ollamaBroker,
  says,
  standInOllama,
  type Reply,
  type StandIn,
} from './ollama-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const QWEN = 'qwen3.6:27b-mlx';
const CANARY = 'canary-ollama-7f3a';

const answers = (model: string): Reply => chatAnswer(model, says(model));

const replyOf = (body: unknown): Record<string, unknown> =>
  (body as Record<string, Record<string, unknown>>)['reply'] ?? {};

// eslint-disable-next-line max-lines-per-function -- one stand-in, one broker and one world
describe.skipIf(serverUrl === undefined)('an Ollama that fails mid-answer', () => {
  let ollama: StandIn;
  let broker: Awaited<ReturnType<typeof ollamaBroker>>;
  let w: ConversationWorld;

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    ollama = await standInOllama();
    broker = await ollamaBroker(ollama.origin);
    const fixture = await createApiFixture('ollama_fails_mid_answer');
    w = await conversationWorld({ fixture, api: composedWith(fixture, broker.exchange) });
  }, 180_000);

  afterAll(async () => {
    await broker?.stop();
    await ollama?.close();
    await w?.drop();
    vi.unstubAllEnvs();
  });

  /** The conversation's calls: state and what each held. */
  async function callsOf(conversationId: string) {
    return await w.fixture.db.admin.execute<Record<string, unknown>>(
      `select state, reserved_minor::int as reserved, provider, route_reach
         from public.model_calls where conversation_id = $1 order by started_at`,
      [conversationId],
    );
  }

  const agentReplies = async (conversationId: string): Promise<number> =>
    await w.count(
      `select count(*)::text as n from public.conversation_messages
        where conversation_id = $1 and role = 'agent'`,
      [conversationId],
    );

  const FAILURES: readonly (readonly [string, Reply])[] = [
    ['answers 500', { status: 500, body: JSON.stringify({ error: CANARY }) }],
    ['closes the socket halfway through its answer', 'close'],
  ];

  it.each(FAILURES)(
    'an Ollama that %s: held at nothing, no reply kept, and the model is free again',
    async (_name, failure) => {
      ollama.reply = () => failure;
      const before = ollama.seen.length;
      let opened;
      try {
        opened = await w.as(w.owner, 'conversation.start', { body: 'What is due today?' });
      } finally {
        ollama.reply = answers;
      }
      expect(opened.status).toBe(200);
      expect(replyOf(opened.body)).toMatchObject({ answered: false });
      expect(String(replyOf(opened.body)['words'])).toContain('could not be used');
      expect(JSON.stringify(opened.body)).not.toContain(CANARY);
      expect(ollama.seen).toHaveLength(before + 1);
      const conversationId = String(detail(opened)['conversationId']);
      expect(await agentReplies(conversationId)).toBe(0);
      expect(await callsOf(conversationId)).toEqual([
        { state: 'liability_unknown', reserved: 0, provider: 'ollama', route_reach: 'local' },
      ]);
      // Not in flight: another question is answered at once, not told the model is busy.
      const other = await w.as(w.owner, 'conversation.start', { body: 'Anything overdue?' });
      expect(replyOf(other.body)).toMatchObject({ answered: true, body: says(QWEN) });
      // And the same question asked again in its conversation gets its answer.
      const again = await w.as(w.owner, 'conversation.message', {
        conversationId,
        body: 'What is due today?',
      });
      expect(replyOf(again.body)).toMatchObject({ answered: true, body: says(QWEN) });
      expect(await agentReplies(conversationId)).toBe(1);
    },
    60_000,
  );

  it('an Ollama that cannot read the request (400): released, nothing kept, free again', async () => {
    ollama.reply = () => ({ status: 400, body: JSON.stringify({ error: CANARY }) });
    let opened;
    try {
      opened = await w.as(w.owner, 'conversation.start', { body: 'Hello?' });
    } finally {
      ollama.reply = answers;
    }
    expect(replyOf(opened.body)).toMatchObject({ answered: false });
    expect(JSON.stringify(opened.body)).not.toContain(CANARY);
    const conversationId = String(detail(opened)['conversationId']);
    expect(await callsOf(conversationId)).toEqual([
      { state: 'released', reserved: 0, provider: 'ollama', route_reach: 'local' },
    ]);
    expect(await agentReplies(conversationId)).toBe(0);
    const other = await w.as(w.owner, 'conversation.start', { body: 'Still there?' });
    expect(replyOf(other.body)).toMatchObject({ answered: true });
  }, 60_000);
});
