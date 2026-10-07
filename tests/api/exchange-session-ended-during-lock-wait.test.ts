// SPDX-License-Identifier: AGPL-3.0-only
//
// The reply is a write, so the session that asked must still stand when it
// commits (OWNER-3). The exchange's keep is admitted, then waits on the
// conversation's row lock, held from another connection `for no key update`
// (so the broker's model_calls insert still takes its key share and the model
// answers). While keep waits, the asker's session is ended and the ending
// commits. When the lock is released, keep must see the ending and keep no
// reply.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endProviderSession } from '../../packages/core-records/src/identity/sessions.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { localModel, type LocalModel } from './aw-03-exchange-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const KEEP_LOCK = /select body_purged_at from conversations/u;

describe.skipIf(serverUrl === undefined)(
  'a session ended while a reply waits',
  // eslint-disable-next-line max-lines-per-function -- one race, set up and watched in one case
  () => {
    let w: ConversationWorld;
    let model: LocalModel;
    beforeAll(async () => {
      w = await conversationWorld('exchange_session_ended');
      model = await localModel();
    }, 180_000);
    afterAll(async () => {
      await model?.close();
      await w?.drop();
    });

    // eslint-disable-next-line max-lines-per-function -- the race, watched step by step
    it('a session ended while the reply waits on the conversation lock keeps no reply', async () => {
      const person = w.colleague;
      const opened = await w.as(person, 'conversation.start', { body: 'Ends before the insert' });
      const asked = {
        conversationId: String(detail(opened)['conversationId']),
        messageId: String(detail(opened)['messageId']),
      };
      const presented = { ...person.presented, sessionId: randomUUID() };

      const watcher = connect(w.fixture.db.appUrl, { source: 'runtime' });
      const second = connect(w.fixture.db.appUrl, { source: 'runtime' });
      const ender = connect(w.fixture.db.appUrl, { source: 'runtime' });
      const keepWaiting = async (): Promise<boolean> => {
        const rows = await watcher.withBusiness(
          w.fixture.business,
          async (tx) =>
            await tx.query<{ query: string }>(
              `select query from pg_stat_activity
                where datname = current_database() and wait_event_type = 'Lock'`,
            ),
        );
        return rows.some((row) => KEEP_LOCK.test(row.query));
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

        const replying = model.exchange(w.fixture.db.app, w.fixture.business, presented, asked);
        let waiting = false;
        const deadline = Date.now() + 20_000;
        while (!waiting && Date.now() < deadline) {
          // eslint-disable-next-line no-await-in-loop -- watching the server for keep's lock wait
          waiting = await keepWaiting();
          if (!waiting) {
            // eslint-disable-next-line no-await-in-loop -- the next look at the server
            await new Promise((resolve) => {
              setImmediate(resolve);
            });
          }
        }
        expect(waiting).toBe(true);

        // The session ends, and the ending commits, while keep waits.
        await ender.withBusiness(w.fixture.business, async (tx) => {
          await endProviderSession(tx, presented.sessionId);
        });

        release();
        await holder;
        const reply = await replying;
        const agentReplies = await w.count(
          'select count(*) as n from public.conversation_messages where answers_message_id = $1',
          [asked.messageId],
        );
        expect({ reply, agentReplies }).toEqual({ reply: null, agentReplies: 0 });
      } finally {
        release();
        await watcher.close();
        await second.close();
        await ender.close();
      }
    }, 60_000);
  },
);
