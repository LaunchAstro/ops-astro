// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's reply moves its conversation's last activity forward
// (`conversation-exchange.ts` `keep`, SEC-B1B F5). The instant it moves to
// must be the reply's own, read when it writes after the conversation's row
// lock, not its transaction's start: a reply whose transaction began before a
// message that was kept while it waited for that lock still advances the
// activity past it, and is listed after it.
//
// The conversation's row is held `for update` on another connection. The
// reply is seen waiting on that holder in `pg_stat_activity`; only then does
// the holder keep a message and stamp the activity, at the database clock,
// and commit.

import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { localModel, type LocalModel } from './aw-03-exchange-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const noop = (): void => undefined;

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

  /** When the reply's transaction began, once it waits on `holder`'s row lock. */
  const replyWaitingOn = async (holder: number): Promise<string> => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
      const rows = await w.fixture.db.admin.execute<{ readonly began: string }>(
        `select a.xact_start::text as began from pg_stat_activity a
          where a.datname = current_database() and a.wait_event_type = 'Lock'
            and $1::int = any(pg_blocking_pids(a.pid))
            and a.query like '%body_purged_at from conversations%'`,
        [holder],
      );
      const began = rows[0]?.began;
      if (began !== undefined) return began;
      // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
      await delay(10);
    }
    throw new Error('the reply never waited on the conversation row');
  };

  it('a reply advances activity past a message kept while it waited for the conversation', async () => {
    const opened = await w.as(w.colleague, 'conversation.start', { body: 'answer me' });
    const asked = {
      conversationId: String(detail(opened)['conversationId']),
      messageId: String(detail(opened)['messageId']),
    };
    let holding: (pid: number) => void = noop;
    const held = new Promise<number>((resolve) => {
      holding = resolve;
    });
    let stamp: () => void = noop;
    const stamped = new Promise<void>((resolve) => {
      stamp = resolve;
    });
    const holder = w.fixture.db.admin.transaction(async (execute) => {
      await execute('select id from public.conversations where id = $1 for update', [
        asked.conversationId,
      ]);
      const [me] = await execute<{ readonly pid: number }>('select pg_backend_pid() as pid');
      holding(Number(me?.pid));
      await stamped;
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
    });
    const pid = await held;
    const replying = model.exchange(
      w.fixture.db.app,
      w.fixture.business,
      w.colleague.presented,
      asked,
    );
    let began: string;
    try {
      began = await replyWaitingOn(pid);
    } finally {
      stamp();
    }
    const keptAt = await holder;
    const reply = await replying;
    const [after] = await w.fixture.db.admin.execute<{
      readonly beganFirst: boolean;
      readonly advanced: boolean;
      readonly order: readonly string[];
    }>(
      `select $2::timestamptz < $3::timestamptz as "beganFirst",
              c.last_activity_at > $3::timestamptz as advanced,
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
