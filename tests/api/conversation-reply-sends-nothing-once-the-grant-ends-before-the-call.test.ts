// SPDX-License-Identifier: AGPL-3.0-only
//
// The exchange reads the owner's question on their conversation grant, then
// asks the broker to call the model. A grant revoked between that read and
// the call's row is judged again in the transaction that writes the row: the
// call is refused, nothing is sent and no reply is kept.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith, localModel, type LocalModel } from './aw-03-exchange-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** The conversation's model calls and kept replies. */
const rowsOf = async (w: ConversationWorld, conversationId: string) => ({
  calls: await w.count('select count(*) as n from public.model_calls where conversation_id = $1', [
    conversationId,
  ]),
  replies: await w.count(
    `select count(*) as n from public.conversation_messages
      where conversation_id = $1 and role = 'agent'`,
    [conversationId],
  ),
});

describe.skipIf(serverUrl === undefined)('a conversation grant revoked before the call', () => {
  let w: ConversationWorld;
  let model: LocalModel;
  let revokeNext = false;

  beforeAll(async () => {
    const base = await conversationWorld('exchange_grant_ends');
    model = await localModel(undefined, async () => {
      if (!revokeNext) return;
      revokeNext = false;
      await base.fixture.db.admin.execute(
        `update public.grants set revoked_at = clock_timestamp()
          where subject_id = $1 and collection = 'conversation' and action = 'write'
            and revoked_at is null`,
        [w.colleague.personId],
      );
    });
    w = await conversationWorld({
      fixture: base.fixture,
      api: composedWith(base.fixture, model.exchange),
    });
  }, 180_000);

  afterAll(async () => {
    await model?.close();
    await w?.drop();
  });

  it("sends nothing and keeps no reply when the owner's grant is revoked after the question is read", async () => {
    const sent = model.provider.seen.length;
    revokeNext = true;
    const opened = await w.as(w.colleague, 'conversation.start', { body: 'Asked as it ends' });
    const conversationId = String(detail(opened)['conversationId']);
    expect({
      revoked: revokeNext,
      reply: (opened.body as Record<string, unknown>)['reply'],
      sent: model.provider.seen.length - sent,
      ...(await rowsOf(w, conversationId)),
    }).toEqual({
      revoked: false,
      reply: expect.not.objectContaining({ answered: true }),
      sent: 0,
      calls: 0,
      replies: 0,
    });
  });
});
