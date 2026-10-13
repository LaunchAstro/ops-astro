// SPDX-License-Identifier: AGPL-3.0-only
//
// A paid call carries only the caller's own words. A conversation whose
// earlier turns include a person turn another actor wrote is refused with no
// row and no request, and the free model still answers it. A field beyond the
// message, the page and the earlier turns is refused too.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { pricedWorld, scopeOf, type PricedWorld } from './priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

// oxlint-disable-next-line max-lines-per-function -- one world, a planted turn and its controls
describe.skipIf(serverUrl === undefined)("another person's turns never reach OpenRouter", () => {
  let p: PricedWorld;

  beforeAll(async () => {
    p = await pricedWorld('priced_own_turns');
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  /** A person turn by `actorId`, and the agent's answer to it, kept earlier in the conversation. */
  async function plantTurn(conversationId: string, actorId: string): Promise<void> {
    const { db, business } = p.w.fixture;
    const question = randomUUID();
    for (const [id, role, author, body, answers, at] of [
      [question, 'person', actorId, 'A colleague asks about the roster.', null, '2 minutes'],
      [randomUUID(), 'agent', p.w.owner.actorId, 'The roster is set.', question, '1 minute'],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- the question, then its answer
      await db.admin.execute(
        `insert into public.conversation_messages
           (business_id, id, conversation_id, role, author_actor_id, body, answers_message_id,
            created_at, context_epoch)
         values ($1, $2, $3, $4, $5, $6, $7, clock_timestamp() - $8::interval,
                 (select context_epoch from public.conversations where id = $3))`,
        [business, id, conversationId, role, author, body, answers, at],
      );
    }
  }

  it("a colleague's turn among the earlier ones: refused, nothing sent; the free model answers", async () => {
    const first = await p.question('What is due today?');
    await p.ask(first);
    await plantTurn(first.conversationId, p.w.colleague.actorId);
    const asked = await p.next(first.conversationId, 'And tomorrow?');
    const sent = p.openrouter.received.length;
    expect(await p.ask(asked)).toMatchObject({ answered: false, code: 'LOCAL_MODEL_REQUIRED' });
    expect(p.openrouter.received.length).toBe(sent);
    expect(await p.calls(first.conversationId)).toHaveLength(1);
    const chosen = await p.w.as(p.w.owner, 'conversation.set_model', {
      conversationId: first.conversationId,
      model: null,
    });
    expect(chosen.status).toBe(200);
    const heard = p.ollama.seen.length;
    const again = await p.next(first.conversationId, 'And the day after?');
    expect(await p.ask(again)).toMatchObject({ answered: true });
    expect(p.ollama.seen.length).toBe(heard + 1);
    expect(p.openrouter.received.length).toBe(sent);
  });

  it('control: the owner’s own earlier turns are carried', async () => {
    const first = await p.question('What is due today?');
    await p.ask(first);
    await plantTurn(first.conversationId, p.w.owner.actorId);
    const asked = await p.next(first.conversationId, 'And tomorrow?');
    expect(await p.ask(asked)).toMatchObject({ answered: true });
  });

  it('a field beyond the message, page and earlier turns is refused', async () => {
    const asked = await p.question('What is due today?');
    const sent = p.openrouter.received.length;
    const scope = scopeOf(p, asked);
    const extra = {
      ...scope,
      fields: [...scope.fields, { name: 'tone', source: 'outside' as const, value: 'brisk' }],
    };
    expect(await p.direct(extra)).toMatchObject({ ok: false, code: 'LOCAL_MODEL_REQUIRED' });
    expect(await p.calls(asked.conversationId)).toHaveLength(0);
    expect(p.openrouter.received.length).toBe(sent);
  });
});
