// SPDX-License-Identifier: AGPL-3.0-only
//
// The reply's last wait is the session check (the subject's and session's
// ending keys, taken shared), so the grant is judged after it, at the clock
// after every wait. The exchange's keep is admitted and waits on the
// conversation's row (held `for no key update`, so the model still answers).
// The asker's one conversation:write grant is given an end a moment ahead. An
// ending of the person's other sessions, which keeps this one, holds the
// subject's ending key; the row is released and keep waits on that key. The
// clock passes the grant's end (the grant is not touched), then the ending
// commits: the session still stands, the grant does not, and no reply is kept.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endOtherSeenSessions } from '../../packages/core-records/src/identity/sessions.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { localModel, type LocalModel } from './aw-03-exchange-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const KEEP_LOCK = /select body_purged_at from conversations/u;

/** Look until the server shows the wait, or fail after 20 s. */
async function until(look: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  // eslint-disable-next-line no-await-in-loop -- watching the server
  while (!(await look())) {
    if (Date.now() > deadline) throw new Error('never waited');
    // eslint-disable-next-line no-await-in-loop -- the next look
    await sleep(10);
  }
}

/** A promise opened from outside. */
function gate(): { open: () => void; passed: Promise<void> } {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- replaced below
  let open: () => void = () => {};
  const passed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, passed };
}

describe.skipIf(serverUrl === undefined)(
  'a grant ending while a reply waits on the session check',
  // eslint-disable-next-line max-lines-per-function -- one race, set up and watched in one case
  () => {
    let w: ConversationWorld;
    let model: LocalModel;
    beforeAll(async () => {
      w = await conversationWorld('exchange_grant_session_wait');
      model = await localModel();
    }, 180_000);
    afterAll(async () => {
      await model?.close();
      await w?.drop();
    });

    // eslint-disable-next-line max-lines-per-function -- the race, watched step by step
    it('a grant that ends while the reply waits on the session check keeps no reply', async () => {
      const person = w.colleague;
      const opened = await w.as(person, 'conversation.start', { body: 'Ends while waiting' });
      const asked = {
        conversationId: String(detail(opened)['conversationId']),
        messageId: String(detail(opened)['messageId']),
      };
      const presented = { ...person.presented, sessionId: randomUUID() };
      const watcher = connect(w.fixture.db.appUrl, { source: 'runtime' });
      const holder = connect(w.fixture.db.appUrl, { source: 'runtime' });
      const ender = connect(w.fixture.db.appUrl, { source: 'runtime' });
      const waitingOn = async (pattern: RegExp, event: string): Promise<boolean> => {
        const rows = await watcher.withBusiness(
          w.fixture.business,
          async (tx) =>
            await tx.query<{ query: string; wait_event: string }>(
              `select query, wait_event from pg_stat_activity
                where datname = current_database() and wait_event_type = 'Lock'`,
            ),
        );
        return rows.some((row) => pattern.test(row.query) && row.wait_event === event);
      };
      const rowHeld = gate();
      const rowRelease = gate();
      const endHeld = gate();
      const endRelease = gate();
      try {
        const holding = holder.withBusiness(w.fixture.business, async (tx) => {
          await tx.query(
            'select id from conversations where business_id = $1 and id = $2 for no key update',
            [tx.businessId, asked.conversationId],
          );
          rowHeld.open();
          await rowRelease.passed;
        });
        await rowHeld.passed;
        const replying = model.exchange(w.fixture.db.app, w.fixture.business, presented, asked);
        await until(async () => await waitingOn(KEEP_LOCK, 'transactionid'));

        // The asker's only conversation:write grant ends a moment from now.
        const [ends] = await w.fixture.db.admin.execute<{ at: Date }>(
          `update public.grants set expires_at = clock_timestamp() + interval '2 seconds'
            where subject_id = $1 and collection = 'conversation' and action = 'write'
              and revoked_at is null
            returning expires_at as at`,
          [person.personId],
        );
        expect(ends?.at).toBeDefined();

        // The person's other sessions end, this one kept: the subject's key is held.
        const ending = ender.withBusiness(w.fixture.business, async (tx) => {
          await endOtherSeenSessions(
            tx,
            person.personId,
            presented.sessionId,
            'end_others',
            presented.subject,
          );
          endHeld.open();
          await endRelease.passed;
        });
        await endHeld.passed;
        rowRelease.open();
        await holding;
        await until(async () => await waitingOn(/./u, 'advisory'));

        // The clock passes the grant's end; then the ending commits.
        await sleep(Math.max(0, (ends?.at.getTime() ?? 0) - Date.now()) + 300);
        endRelease.open();
        await ending;
        const reply = await replying;
        const agentReplies = await w.count(
          'select count(*) as n from public.conversation_messages where answers_message_id = $1',
          [asked.messageId],
        );
        expect({ reply, agentReplies }).toEqual({ reply: null, agentReplies: 0 });
      } finally {
        rowRelease.open();
        endRelease.open();
        await watcher.close();
        await holder.close();
        await ender.close();
      }
    }, 60_000);
  },
);
