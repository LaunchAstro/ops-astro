// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's reply moves its conversation's last activity forward
// (`conversation-exchange.ts` `keep`, SEC-B1B F5). The instant it moves to
// must be the reply's own, read when it writes after the conversation's row
// lock, not its transaction's start: a reply whose transaction began before a
// message that was kept while it waited for that lock still advances the
// activity past it, and is listed after it.
//
// The conversation's row is held `for no key update` on another connection:
// the reply's `for update` waits on it, while a key-share check on the row
// (another step's foreign key) does not, so the one waiter is the reply. The
// reply is seen waiting on that holder in `pg_stat_activity`; only then does
// the holder keep a message and stamp the activity, at the database clock,
// and commit.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, waiterOf } from '../support/lock-wait-race.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { localModel, type LocalModel } from './aw-03-exchange-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('agent reply activity order', () => {
  let w: ConversationWorld;
  let model: LocalModel;

  beforeAll(async () => {
    w = await conversationWorld('agentreplyorder');
    model = await localModel();
  }, 180_000);

  afterAll(async () => {
    await model?.close();
    await w?.drop();
  });

  it('a reply advances activity past a message kept while it waited for the conversation', async () => {
    const opened = await w.as(w.colleague, 'conversation.start', { body: 'answer me' });
    const asked = {
      conversationId: String(detail(opened)['conversationId']),
      messageId: String(detail(opened)['messageId']),
    };
    const held = await hold(
      w.fixture.db,
      async (execute) => {
        await execute('select id from public.conversations where id = $1 for no key update', [
          asked.conversationId,
        ]);
      },
      async (execute) => {
        await execute(
          `insert into public.conversation_messages
             (business_id, id, conversation_id, role, author_actor_id, body, created_at)
           select c.business_id, gen_random_uuid(), c.id, 'person', c.owner_actor_id,
                  'kept while the reply waited', clock_timestamp()
             from public.conversations c where c.id = $1`,
          [asked.conversationId],
        );
        const [kept] = await execute<{ readonly at: string }>(
          `update public.conversations set last_activity_at = clock_timestamp()
            where id = $1 returning last_activity_at::text as at`,
          [asked.conversationId],
        );
        return kept?.at;
      },
    );
    const replying = model.exchange(
      w.fixture.db.app,
      w.fixture.business,
      w.colleague.presented,
      asked,
    );
    let began: string;
    let keptAt: string | undefined;
    try {
      began = await waiterOf(w.fixture.db, held);
    } finally {
      keptAt = await held.letGo();
    }
    const reply = await replying;
    // The instants go in as text: bound as timestamptz, the driver passes
    // them through a JavaScript Date, which keeps milliseconds only, and an
    // activity left at the kept message's stamp would read as past it.
    const [after] = await w.fixture.db.admin.execute<{
      readonly beganFirst: boolean;
      readonly advanced: boolean;
      readonly order: readonly string[];
    }>(
      `select $2::text::timestamptz < $3::text::timestamptz as "beganFirst",
              c.last_activity_at > $3::text::timestamptz as advanced,
              array(select m.role || ':' || left(m.body, 27) from public.conversation_messages m
                     where m.business_id = c.business_id and m.conversation_id = c.id
                     order by m.created_at, m.id) as "order"
         from public.conversations c where c.id = $1`,
      [asked.conversationId, began, keptAt],
    );
    expect({ answered: reply?.answered, ...after }).toEqual({
      answered: true,
      beganFirst: true,
      advanced: true,
      order: [
        'person:answer me',
        'person:kept while the reply waited',
        expect.stringMatching(/^agent:/u),
      ],
    });
  }, 60_000);
});
