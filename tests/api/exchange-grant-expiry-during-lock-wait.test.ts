// SPDX-License-Identifier: AGPL-3.0-only
//
// The review's proof (#819, criterion 5), renamed for what it proves and
// otherwise as written. The exchange's keep
// takes the conversation's row lock, then asks the conversation grant again.
// A separate session holds the conversation row (and revokes nothing), so
// keep waits on its lock after its transaction has started. The hold is
// `for no key update`: it blocks keep's `for update` and, unlike `for update`,
// lets the broker's model_calls insert take its foreign key share on the row,
// so the model answers and only keep waits. The
// owner's one conversation:write grant carries a future end; while keep waits,
// the clock reaches that end (the fixture moves the stored end to the database
// clock, as `age` moves a conversation's activity, never sleeping). When the
// lock is released the grant is expired, so the re-check must refuse it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { localModel, type LocalModel } from './aw-03-exchange-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const KEEP_LOCK = /select body_purged_at from conversations/u;

describe.skipIf(serverUrl === undefined)(
  'a conversation grant expiring while a reply waits',
  // eslint-disable-next-line max-lines-per-function -- one race, set up and watched in one case
  () => {
    let w: ConversationWorld;
    let model: LocalModel;
    beforeAll(async () => {
      w = await conversationWorld('exchange_grant_expiry');
      model = await localModel();
    }, 180_000);
    afterAll(async () => {
      await model?.close();
      await w?.drop();
    });

    // eslint-disable-next-line max-lines-per-function -- the review's proof, as written
    it('a grant expired while the reply waits on the conversation lock keeps no reply', async () => {
      const person = w.colleague;
      const opened = await w.as(person, 'conversation.start', {
        body: 'Expires before the insert',
      });
      const asked = {
        conversationId: String(detail(opened)['conversationId']),
        messageId: String(detail(opened)['messageId']),
      };
      // The owner's only covering conversation:write grant, given a future end.
      const grants = await w.fixture.db.admin.execute<{ id: string }>(
        `update public.grants set expires_at = now() + interval '1 hour'
        where subject_id = $1 and collection = 'conversation' and action = 'write'
          and revoked_at is null
        returning id`,
        [person.personId],
      );
      expect(grants).toHaveLength(1);
      const grantId = grants[0]?.id as string;

      const watcher = connect(w.fixture.db.appUrl, { source: 'runtime' });
      const second = connect(w.fixture.db.appUrl, { source: 'runtime' });
      const keepWaiting = async (): Promise<{ xact_start: Date } | undefined> => {
        const rows = await watcher.withBusiness(
          w.fixture.business,
          async (tx) =>
            await tx.query<{ query: string; xact_start: Date }>(
              `select query, xact_start from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'`,
            ),
        );
        return rows.find((row) => KEEP_LOCK.test(row.query));
      };

      // eslint-disable-next-line unicorn/consistent-function-scoping -- replaced below
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      // eslint-disable-next-line unicorn/consistent-function-scoping -- replaced below
      let lockHeld: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        lockHeld = resolve;
      });
      try {
        // The holder: the conversation row, locked from a separate connection.
        const holder = second.withBusiness(w.fixture.business, async (tx) => {
          const locked = await tx.query(
            'select id from conversations where business_id = $1 and id = $2 for no key update',
            [tx.businessId, asked.conversationId],
          );
          expect(locked).toHaveLength(1);
          lockHeld();
          await released;
        });
        await held;

        // The exchange starts while the grant is live.
        const replying = model.exchange(
          w.fixture.db.app,
          w.fixture.business,
          person.presented,
          asked,
        );
        let waiting: { xact_start: Date } | undefined;
        const deadline = Date.now() + 20_000;
        while (waiting === undefined && Date.now() < deadline) {
          // eslint-disable-next-line no-await-in-loop -- watching the server for keep's lock wait
          waiting = await keepWaiting();
          if (waiting === undefined) {
            // eslint-disable-next-line no-await-in-loop -- the next look at the server
            await new Promise((resolve) => {
              setImmediate(resolve);
            });
          }
        }
        expect(waiting).toBeDefined();

        // The clock reaches the grant's end while keep waits: the stored end
        // moves to the database clock, after keep's transaction began.
        const [lapsed] = await w.fixture.db.admin.execute<{
          expires_at: Date;
          expired: boolean;
        }>(
          `update public.grants set expires_at = clock_timestamp() where id = $1
          returning expires_at, expires_at <= clock_timestamp() as expired`,
          [grantId],
        );
        expect(lapsed?.expired).toBe(true);
        expect(lapsed?.expires_at.getTime()).toBeGreaterThan(
          // eslint-disable-next-line no-unsafe-optional-chaining -- asserted defined above
          (waiting?.xact_start as Date).getTime(),
        );

        release();
        await holder;
        const reply = await replying;
        const agentReplies = await w.count(
          "select count(*) as n from public.conversation_messages where conversation_id = $1 and role = 'agent'",
          [asked.conversationId],
        );
        expect({ reply, agentReplies }).toEqual({ reply: null, agentReplies: 0 });
      } finally {
        release();
        await watcher.close();
        await second.close();
      }
    }, 60_000);
  },
);
