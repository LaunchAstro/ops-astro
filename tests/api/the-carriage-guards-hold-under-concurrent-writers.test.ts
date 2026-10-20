// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- one database and one schedule per guard and writer */
//
// The members and carriers guards (0101, 0102) under writers at the same
// moment, each on a connection of its own, ordered by what `pg_stat_activity`
// shows. The members guard reads the agent's and the conversation's rows for
// share, so a deactivation or a purge in flight is either seen or waits. The
// carriers guard sets each time once, so a second offer or send waiting on the
// first is refused when the first commits, and the doorbell rings once. A
// writer that dies leaves the other's write. Also: two open rows at once, one
// naming the conversation in capitals, are one row; another business's agent
// or call is refused; and a carriers row written while its call is being
// released (by a writer outside the call's own transaction).
//
// The database stands where a hosted project stands (the Realtime shim), so
// the doorbell's broadcasts can be counted.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold } from '../support/lock-wait-race.ts';
import { createRealtimeDatabase, type RealtimeDatabase } from '../support/realtime-database.ts';
import {
  carriageBusiness,
  carriedCall,
  conversationOf,
  doorbellTopic,
  type CarriageBusiness,
} from './carriage-fixture.ts';
import { holdApp, waitersOf } from './carried-exchange-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const OPEN = `insert into conversation_agent_members
                (business_id, conversation_id, agent_actor_id, added_by_actor_id)
              values ($1, $2, $3, $4)`;
const DEACTIVATE = `update public.actors set active = false, deactivated_at = clock_timestamp()
                     where id = $1`;
const PURGE = `update public.conversations
                  set body_purged_at = clock_timestamp(), purge_operation_id = gen_random_uuid()::text
                where id = $1`;
const OFFER = `update model_call_carriers set offered_at = clock_timestamp()
                where business_id = $1 and call_id = $2`;
const SEND = `update model_call_carriers
                 set runner = gen_random_uuid(), request_at = clock_timestamp(),
                     send_by = clock_timestamp() + interval '5 seconds',
                     answer_by = clock_timestamp() + interval '120 seconds'
               where business_id = $1 and call_id = $2`;

const GUARD_OPEN = "an open row is an active agent's, unpurged";
const GUARD_ONCE = 'written unset for a dispatched call, set once';

// eslint-disable-next-line max-lines-per-function -- one database, one schedule per guard
describe.skipIf(serverUrl === undefined)('the carriage guards under concurrent writers', () => {
  let db: RealtimeDatabase;
  let alpha: CarriageBusiness;
  let beta: CarriageBusiness;

  beforeAll(async () => {
    db = await createRealtimeDatabase('carriage_guard_race');
    alpha = await carriageBusiness(db.app, 'alpha');
    beta = await carriageBusiness(db.app, 'beta');
  }, 180_000);

  afterAll(async () => await db?.drop());

  /** A fresh active agent of alpha's and a conversation of the owner's with no member. */
  async function fresh(): Promise<{ readonly agent: string; readonly conversationId: string }> {
    return await db.app.withBusiness(alpha.id, async (tx) => {
      const agent = randomUUID();
      await tx.query(
        `insert into actors (business_id, id, kind, person_id, active) values ($1, $2, 'agent', null, true)`,
        [tx.businessId, agent],
      );
      const { conversationId } = await conversationOf(tx, alpha.owner);
      return { agent, conversationId };
    });
  }

  const openRows = async (conversationId: string) =>
    await db.admin.execute<{ readonly n: number }>(
      `select count(*)::int as n from public.conversation_agent_members
        where conversation_id = $1 and left_at is null`,
      [conversationId],
    );

  /** An open row written by the application role on a connection of its own; answers its error. */
  const openNow = async (conversationId: string, agent: string): Promise<string | null> => {
    try {
      const held = await holdApp(db.appUrl, alpha.id, async (tx) => {
        await tx.query(OPEN, [tx.businessId, conversationId, agent, alpha.owner.actor]);
      });
      await held.letGo();
      return null;
    } catch (error) {
      return String((error as Error).message);
    }
  };

  it.each([
    ['deactivation', DEACTIVATE, 'agent'],
    ['purge', PURGE, 'conversation'],
  ] as const)(
    'closer first (%s): an open row waiting on it is refused when it commits',
    async (_name, statement, target) => {
      const { agent, conversationId } = await fresh();
      const closer = await hold(db, async (execute) => {
        await execute(statement, [target === 'agent' ? agent : conversationId]);
      });
      try {
        const opening = openNow(conversationId, agent);
        await waitersOf(db.admin, closer.pid);
        await closer.letGo();
        expect(await opening).toContain(GUARD_OPEN);
        expect(await openRows(conversationId)).toEqual([{ n: 0 }]);
      } finally {
        await closer.letGo();
      }
    },
  );

  it.each([
    ['deactivation', DEACTIVATE, 'agent'],
    ['purge', PURGE, 'conversation'],
  ] as const)(
    'open row first (%s): the closer waits for it, and closes it',
    async (_name, statement, target) => {
      const { agent, conversationId } = await fresh();
      const opener = await holdApp(db.appUrl, alpha.id, async (tx) => {
        await tx.query(OPEN, [tx.businessId, conversationId, agent, alpha.owner.actor]);
      });
      let closing: Promise<unknown> | undefined;
      try {
        closing = (async () => {
          const closer = await hold(db, async (execute) => {
            await execute(statement, [target === 'agent' ? agent : conversationId]);
          });
          await closer.letGo();
        })();
        await waitersOf(db.admin, opener.pid);
        await opener.letGo();
        await closing;
        expect(await openRows(conversationId)).toEqual([{ n: 0 }]);
        const [all] = await db.admin.execute<{ readonly n: number }>(
          'select count(*)::int as n from public.conversation_agent_members where conversation_id = $1',
          [conversationId],
        );
        expect(all?.n).toBe(1);
      } finally {
        await opener.letGo();
        await closing?.catch(() => null);
      }
    },
  );

  it('crash: a deactivation that dies leaves the open row waiting on it', async () => {
    const { agent, conversationId } = await fresh();
    const closer = await hold(
      db,
      async (execute) => {
        await execute(DEACTIVATE, [agent]);
      },
      async () => await Promise.reject(new Error('the deactivating process died')),
    );
    const opening = openNow(conversationId, agent);
    await waitersOf(db.admin, closer.pid);
    await expect(closer.letGo()).rejects.toThrow('the deactivating process died');
    expect(await opening).toBeNull();
    expect(await openRows(conversationId)).toEqual([{ n: 1 }]);
  });

  it('upper case: two open rows at once, one naming the conversation in capitals, are one row', async () => {
    const { agent, conversationId } = await fresh();
    const first = await holdApp(db.appUrl, alpha.id, async (tx) => {
      await tx.query(OPEN, [tx.businessId, conversationId.toUpperCase(), agent, alpha.owner.actor]);
    });
    try {
      const second = openNow(conversationId, agent);
      await waitersOf(db.admin, first.pid);
      await first.letGo();
      expect(await second).toContain('conversation_agent_members_one_open_idx');
      expect(await openRows(conversationId)).toEqual([{ n: 1 }]);
    } finally {
      await first.letGo();
    }
  });

  it("scope: an open row for another business's agent, or a carriers row for its call, is refused", async () => {
    const { conversationId } = await fresh();
    expect(await openNow(conversationId, beta.agent.actor)).toMatch(
      /foreign key|violates|active agent/u,
    );
    const refused = await db.app
      .withBusiness(alpha.id, async (tx) => {
        await tx.query(
          `insert into model_call_carriers (business_id, call_id, agent_actor_id) values ($1, $2, $3)`,
          [tx.businessId, beta.callId, alpha.agent.actor],
        );
      })
      .then(
        () => null,
        (error: unknown) => String((error as Error).message),
      );
    expect(refused).not.toBeNull();
  });

  /** A carried call of alpha's, with no time set on its carriers row. */
  const newCall = async () =>
    await db.app.withBusiness(
      alpha.id,
      async (tx) => await carriedCall(tx, alpha.owner, alpha.agent),
    );

  const rings = async (callId: string) =>
    await db.admin.execute<{ readonly n: number }>(
      `select count(*)::int as n from realtime.messages
        where topic = $1 and payload ->> 'k' = $2`,
      [doorbellTopic(alpha.id, alpha.agent.actor), callId],
    );

  /** A second writer of `statement` on a connection of its own, while `first` holds its own. */
  async function twice(statement: string, callId: string, dies = false) {
    const first = await holdApp(db.appUrl, alpha.id, async (tx) => {
      await tx.query(statement, [tx.businessId, callId]);
    });
    const second = holdApp(db.appUrl, alpha.id, async (tx) => {
      await tx.query(statement, [tx.businessId, callId]);
    }).then(
      async (held) => {
        await held.letGo();
        return null;
      },
      (error: unknown) => String((error as Error).message),
    );
    await waitersOf(db.admin, first.pid);
    await (dies
      ? expect(
          first.letGo(async () => await Promise.reject(new Error('the first writer died'))),
        ).rejects.toThrow('the first writer died')
      : first.letGo());
    return await second;
  }

  it('a second offer waiting on the first is refused, and the doorbell rings once', async () => {
    const { callId } = await newCall();
    expect(await twice(OFFER, callId)).toContain(GUARD_ONCE);
    expect(await rings(callId)).toEqual([{ n: 1 }]);
  });

  it('crash: an offer that dies leaves the waiting one, which rings once', async () => {
    const { callId } = await newCall();
    expect(await twice(OFFER, callId, true)).toBeNull();
    expect(await rings(callId)).toEqual([{ n: 1 }]);
  });

  it('a second send waiting on the first is refused: one runner, one request time', async () => {
    const { callId } = await newCall();
    await db.app.withBusiness(alpha.id, async (tx) => {
      await tx.query(OFFER, [tx.businessId, callId]);
    });
    expect(await twice(SEND, callId)).toContain(GUARD_ONCE);
    const [sent] = await db.admin.execute<{ readonly runners: number }>(
      `select count(runner)::int as runners from public.model_call_carriers where call_id = $1`,
      [callId],
    );
    expect(sent?.runners).toBe(1);
  });

  // eslint-disable-next-line max-lines-per-function -- one schedule, its checks and its clean-up
  it('a carriers row written while its call is being released is refused when the release commits', async () => {
    const callId = await db.app.withBusiness(alpha.id, async (tx) => {
      const { conversationId, messageId } = await conversationOf(tx, alpha.owner);
      const id = randomUUID();
      await tx.query(
        `insert into model_calls
           (business_id, id, conversation_id, conversation_message_id, operation_key, state,
            reserved_minor, route_key, route_reach, credential_kind, provider, credential_ref,
            started_at)
         values ($1, $2, $3, $4, 'conversation.answer', 'dispatched', 0, 'm5_ollama', 'local',
                 'api_key', 'ollama', 'none', clock_timestamp())`,
        [tx.businessId, id, conversationId, messageId],
      );
      return id;
    });
    const release = await hold(db, async (execute) => {
      await execute(
        `update public.model_calls set state = 'released', ended_at = clock_timestamp(), drop_state = null
          where id = $1`,
        [callId],
      );
    });
    let writing: Promise<string | null> | undefined;
    try {
      writing = holdApp(db.appUrl, alpha.id, async (tx) => {
        await tx.query(
          `insert into model_call_carriers (business_id, call_id, agent_actor_id) values ($1, $2, $3)`,
          [tx.businessId, callId, alpha.agent.actor],
        );
      }).then(
        async (held) => {
          await held.letGo();
          return null;
        },
        (error: unknown) => String((error as Error).message),
      );
      // The guard's read of the call queues behind the release, which then commits.
      await waitersOf(db.admin, release.pid);
      await release.letGo();
      const outcome = await writing;
      const [row] = await db.admin.execute<{ readonly state: string; readonly carried: boolean }>(
        `select c.state, exists (select 1 from public.model_call_carriers k where k.call_id = c.id) as carried
           from public.model_calls c where c.id = $1`,
        [callId],
      );
      expect(
        { outcome: outcome === null ? 'written' : 'refused', ...row },
        'a carriers row for a call no longer dispatched: the guard did not wait for the release',
      ).toEqual({ outcome: 'refused', state: 'released', carried: false });
    } finally {
      await release.letGo();
      await writing?.catch(() => null);
    }
  });
});
