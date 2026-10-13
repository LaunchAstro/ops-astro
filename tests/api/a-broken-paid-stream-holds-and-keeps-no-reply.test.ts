// SPDX-License-Identifier: AGPL-3.0-only
//
// A paid stream that breaks after OpenRouter's 200 may have charged: before
// the first piece, after pieces, or with an error event, the call is held at
// its most, no reply is kept, and the panel says the cost stays set aside. A
// 402 is OpenRouter's refusal before any work: released. A 503 may not be:
// held. The reconciliation pass leaves a held paid call to its owner.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reconcileProviderCalls } from '../../packages/core-custody/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { event, sse, type Answer } from './openrouter-stand-in-fixture.ts';
import { HAIKU, pricedWorld, type PricedWorld } from '../broker/priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

// oxlint-disable-next-line max-lines-per-function -- one world, a case per way a paid stream ends
describe.skipIf(serverUrl === undefined)('a broken paid stream', () => {
  let p: PricedWorld;

  beforeAll(async () => {
    p = await pricedWorld('priced_broken_stream', undefined, 1, true);
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  const replies = async (conversationId: string): Promise<number> =>
    await p.w.count(
      `select count(*)::text as n from public.conversation_messages
        where conversation_id = $1 and role = 'agent'`,
      [conversationId],
    );

  async function endsWith(answer: Answer) {
    p.openrouter.answer = () => answer;
    const asked = await p.question('What is due today?');
    const reply = await p.ask(asked);
    const [call] = await p.calls(asked.conversationId);
    return { reply, call, kept: await replies(asked.conversationId) };
  }

  it.each([
    [
      'cut before the first piece',
      { status: 200, chunks: [': OPENROUTER PROCESSING\n\n'], cut: true },
    ],
    [
      'cut after pieces',
      { status: 200, chunks: sse(HAIKU, ['Two ', 'tasks']).slice(0, 3), cut: true },
    ],
    [
      'an error event',
      {
        status: 200,
        chunks: [
          event({ model: HAIKU, choices: [{ delta: { content: 'Two' } }] }),
          event({ error: { code: 502, message: 'upstream failed' } }),
          'data: [DONE]\n\n',
        ],
      },
    ],
    ['a 503', { status: 503, body: '{"error":{"code":503}}' }],
  ] as const)('%s: held at the most, nothing kept', async (_name, answer) => {
    const { reply, call, kept } = await endsWith(answer as Answer);
    expect(reply).toMatchObject({ answered: false, code: 'LIABILITY_UNKNOWN' });
    expect(reply && !reply.answered ? reply.words : '').toContain('stays set aside');
    expect(call).toMatchObject({ state: 'liability_unknown' });
    expect(Number(call?.['reserved_minor'])).toBeGreaterThan(0);
    expect(kept).toBe(0);
  });

  it('a 402: released, nothing held', async () => {
    const { reply, call, kept } = await endsWith({ status: 402, body: '{"error":{"code":402}}' });
    expect(reply).toMatchObject({ answered: false });
    expect(call).toMatchObject({ state: 'released' });
    expect(kept).toBe(0);
  });

  it('the reconciliation pass leaves a held paid call to its owner', async () => {
    const { call } = await endsWith({ status: 503, body: '{}' });
    await expect(
      reconcileProviderCalls(
        p.w.fixture.db.app,
        p.w.fixture.business,
        { ...p.broker, audit: async () => await Promise.resolve() },
        new Set(),
      ),
    ).resolves.not.toThrow();
    const [after] = await p.w.fixture.db.admin.execute<{ readonly state: string }>(
      'select state from public.model_calls where id = $1',
      [call?.['id']],
    );
    expect(after?.state).toBe('liability_unknown');
  });
});
