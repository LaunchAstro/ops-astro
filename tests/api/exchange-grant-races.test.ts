// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #422, OW-031.3 (Refs #422): the races on the reply's grant
// re-check. The exchange keeps a reply only under the conversation's row lock,
// with the caller's conversation grants held for share and asked at the clock
// after the locks. Each case runs on its own connections: a revocation waits
// for a reply whose check has passed, a grant issued while the reply waited on
// the row is held too, and a grant that lapses during that wait keeps nothing.

import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revokeGrant, type TenantQuery } from '../../packages/core-records/src/index.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { localModel, type LocalModel } from './aw-03-exchange-fixture.ts';
import { createControls } from './controls-fixture.ts';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

/** The advisory key the reply gate waits on. */
const GATE = 819_422;

interface Asked {
  readonly conversationId: string;
  readonly messageId: string;
}

async function lockConversation(tx: TenantQuery, asked: Asked): Promise<void> {
  await tx.query('select id from conversations where business_id = $1 and id = $2 for update', [
    tx.businessId,
    asked.conversationId,
  ]);
}

describe.skipIf(serverUrl === undefined)(
  'the races on the exchange reply grant re-check',
  // eslint-disable-next-line max-lines-per-function -- one world, every case on it
  () => {
    let w: ConversationWorld;
    let model: LocalModel;
    beforeAll(async () => {
      w = await conversationWorld(await createControls('exchange_grant_races'));
      model = await localModel();
    }, 180_000);
    afterAll(async () => {
      await model?.close();
      await w?.drop();
    });

    it('a revocation waits for a reply whose grant check has passed', async () => {
      const asked = await ask('Revoked at the insert');
      const gate = connect(w.fixture.db.appUrl, { source: 'runtime' });
      const revoker = connect(w.fixture.db.appUrl, { source: 'runtime' });
      let revoking: Promise<void> | undefined;
      try {
        await gateReplies();
        let replying: Promise<unknown> | undefined;
        await gate.withBusiness(w.fixture.business, async (tx) => {
          await tx.query(`select pg_advisory_xact_lock(${GATE})`);
          replying = exchange(asked);
          await waiting('advisory', 1);
          revoking = revoker.withBusiness(w.fixture.business, revokeConversationWrite);
          expect(await revokedOrWaiting(revoking)).toBe('waiting');
        });
        expect(await replying).toMatchObject({ answered: true });
        await revoking;
        expect(await agentReplies(asked)).toBe(1);
      } finally {
        await revoking?.catch(() => null);
        await Promise.allSettled([gate, revoker].map((one) => one.close()));
        await ungate();
        await restore();
      }
    });

    it('a grant issued while the reply waits on its lock is held until the reply commits', async () => {
      const asked = await ask('Issued mid-wait');
      const gate = connect(w.fixture.db.appUrl, { source: 'runtime' });
      const holder = connect(w.fixture.db.appUrl, { source: 'runtime' });
      const issuer = connect(w.fixture.db.appUrl, { source: 'runtime' });
      const revoker = connect(w.fixture.db.appUrl, { source: 'runtime' });
      let revoking: Promise<void> | undefined;
      try {
        await gateReplies();
        let replying: Promise<unknown> | undefined;
        await gate.withBusiness(w.fixture.business, async (gated) => {
          await gated.query(`select pg_advisory_xact_lock(${GATE})`);
          let issued = '';
          await holder.withBusiness(w.fixture.business, async (tx) => {
            await lockConversation(tx, asked);
            replying = exchange(asked);
            await waiting('transactionid', 1);
            // The old grant goes and a new one comes, both committed while the
            // reply waits; a reply holding the old grant fails this, not hangs.
            issued = await issuer.withBusiness(w.fixture.business, async (each) => {
              await each.query(`set local lock_timeout = '5s'`);
              await revokeConversationWrite(each);
              return await grantTo(each, w.owner, 'write', undefined, false, 'conversation');
            });
          });
          await waiting('advisory', 1);
          revoking = revoker.withBusiness(w.fixture.business, async (tx) => {
            await revokeGrant(tx, issued);
          });
          expect(await revokedOrWaiting(revoking)).toBe('waiting');
        });
        expect(await replying).toMatchObject({ answered: true });
        await revoking;
        expect(await agentReplies(asked)).toBe(1);
      } finally {
        await revoking?.catch(() => null);
        await Promise.allSettled([gate, holder, issuer, revoker].map((one) => one.close()));
        await ungate();
        await restore();
      }
    });

    it('a conversation grant that lapses while the reply waits on its lock keeps no reply', async () => {
      const asked = await ask('Lapsed mid-wait');
      const ends = await lapsingGrant();
      const holder = connect(w.fixture.db.appUrl, { source: 'runtime' });
      let replying: Promise<unknown> | undefined;
      try {
        // The grant is live when the reply's transaction starts and lapses
        // while it waits on the conversation's row lock; nothing is revoked.
        await holder.withBusiness(w.fixture.business, async (tx) => {
          await lockConversation(tx, asked);
          replying = exchange(asked);
          await waiting('transactionid', 1);
          expect(
            await w.count(
              `select count(*) as n from pg_stat_activity
                where datname = current_database() and wait_event = 'transactionid'
                  and query ilike '%from conversations%for update%'
                  and xact_start < $1::timestamptz`,
              [ends],
            ),
          ).toBe(1);
          await lapsed(ends);
        });
        expect(await replying).toBeNull();
        expect(await agentReplies(asked)).toBe(0);
      } finally {
        await Promise.allSettled([holder.close()]);
        await restore();
      }
    });

    /** The owner's new conversation, as the exchange is asked about it. */
    async function ask(body: string): Promise<Asked> {
      const opened = await w.as(w.owner, 'conversation.start', { body });
      return {
        conversationId: String(detail(opened)['conversationId']),
        messageId: String(detail(opened)['messageId']),
      };
    }

    async function exchange(asked: Asked): Promise<unknown> {
      return await model.exchange(w.fixture.db.app, w.fixture.business, w.owner.presented, asked);
    }

    async function agentReplies(asked: Asked): Promise<number> {
      return await w.count(
        "select count(*) as n from public.conversation_messages where conversation_id = $1 and role = 'agent'",
        [asked.conversationId],
      );
    }

    /** Whether the revocation committed under the paused reply, or waits for it. */
    async function revokedOrWaiting(revoking: Promise<void>): Promise<string> {
      return await Promise.race([
        revoking.then(() => 'revoked'),
        waiting('Lock', 2).then(() => 'waiting'),
      ]);
    }

    async function revokeConversationWrite(tx: TenantQuery): Promise<void> {
      const grants = await tx.query<{ id: string }>(
        "select id from grants where subject_id = $1 and collection = 'conversation' and action = 'write' and revoked_at is null",
        [w.owner.personId],
      );
      expect(grants.length).toBeGreaterThan(0);
      // eslint-disable-next-line no-await-in-loop -- grant changes share one transaction
      for (const grant of grants) await revokeGrant(tx, grant.id);
    }

    async function restore(): Promise<void> {
      await w.fixture.db.app.withBusiness(
        w.fixture.business,
        async (tx) => await grantTo(tx, w.owner, 'write', undefined, false, 'conversation'),
      );
    }

    /**
     * The barrier: an agent reply waits, as it is inserted, on the advisory
     * lock the gate holds. By then the exchange has held and asked the grant.
     */
    async function gateReplies(): Promise<void> {
      await w.fixture.db.admin.execute(
        `create function public.test_reply_gate() returns trigger language plpgsql as $$
         begin
           if new.role = 'agent' then perform pg_advisory_xact_lock_shared(${GATE}); end if;
           return new;
         end $$`,
      );
      await w.fixture.db.admin.execute(
        `create trigger test_reply_gate before insert on public.conversation_messages
           for each row execute function public.test_reply_gate()`,
      );
    }

    async function ungate(): Promise<void> {
      await w.fixture.db.admin.execute(
        'drop trigger if exists test_reply_gate on public.conversation_messages',
      );
      await w.fixture.db.admin.execute('drop function if exists public.test_reply_gate()');
    }

    /** The owner's only conversation grant, replaced by one ending in 4 seconds. */
    async function lapsingGrant(): Promise<Date> {
      const [clock] = await w.fixture.db.admin.execute<{ readonly ends: Date }>(
        `select clock_timestamp() + interval '4 seconds' as ends`,
      );
      const ends = clock?.ends;
      if (ends === undefined) throw new Error('the database returned no clock');
      await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
        await revokeConversationWrite(tx);
        const issued = await issueGrant(tx, [], {
          subject: { kind: 'person', id: w.owner.personId },
          scope: { kind: 'business', id: null },
          collection: 'conversation',
          action: 'write',
          canDelegate: false,
          parentGrantId: null,
          grantedByActorId: w.owner.actorId,
          expiresAt: ends,
        });
        if (!issued.ok) throw new Error(`issueGrant refused ${issued.refusal.code}`);
      });
      return ends;
    }

    /**
     * Waits until `n` backends in this database wait on `event`: a wait event
     * name (`advisory`, `transactionid`) or `Lock` for any lock.
     */
    async function waiting(event: string, n: number): Promise<void> {
      for (let tries = 0; tries < 400; tries += 1) {
        // eslint-disable-next-line no-await-in-loop -- polling the server
        const found = await w.count(
          `select count(*) as n from pg_stat_activity
            where datname = current_database()
              and (wait_event = $1 or ($1 = 'Lock' and wait_event_type = 'Lock'))`,
          [event],
        );
        if (found >= n) return;
        // eslint-disable-next-line no-await-in-loop
        await sleep(25);
      }
      throw new Error(`${n} backends never waited on ${event}`);
    }

    /** Waits until the database clock is past `ends`. */
    async function lapsed(ends: Date): Promise<void> {
      for (let tries = 0; tries < 400; tries += 1) {
        // eslint-disable-next-line no-await-in-loop -- polling the server
        const past = await w.count(
          'select count(*) as n where clock_timestamp() > $1::timestamptz',
          [ends],
        );
        if (past === 1) return;
        // eslint-disable-next-line no-await-in-loop
        await sleep(50);
      }
      throw new Error('the grant never lapsed');
    }
  },
);
