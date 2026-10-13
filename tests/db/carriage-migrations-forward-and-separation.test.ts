// SPDX-License-Identifier: AGPL-3.0-only
//
// The four carriage migrations (a call's message, agent members, carriers,
// the join function) on an install stopped just before them, with a
// conversation already answered: they apply over its rows, which keep their
// call and gain a null message. Then the separation each new key and policy
// holds: a business sees and writes only its own members and carriers, and a
// call, a membership or a carriers row cannot name another business's or
// another conversation's row.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../support/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import {
  carriageBusiness,
  carriersRow,
  conversationOf,
  dispatchedCall,
  openMembership,
  type CarriageBusiness,
} from '../api/carriage-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const ALL = readMigrations('migrations');
/** The first carriage migration's UTC timestamp ID. */
const FIRST = '20261013010000';
const BEFORE = ALL.filter((m) => m.version < FIRST);
const CARRIAGE = ALL.filter((m) => m.version >= FIRST && m.version < '20261013010400');

// eslint-disable-next-line max-lines-per-function -- one install, upgraded, then its separations
describe.skipIf(serverUrl === undefined)('the carriage migrations', () => {
  let db: EmptyDatabase;
  let earlier: { business: string; callId: string; conversationId: string };
  let alpha: CarriageBusiness;
  let bravo: CarriageBusiness;

  beforeAll(async () => {
    db = await createEmptyDatabase({ part: 'carriage_forward' });
    await applyMigrations(db.admin, BEFORE);
    // An install before carriage, with a conversation call already made.
    const business = await insertBusiness(db.app, 'earlier');
    earlier = await db.app.withBusiness(business, async (tx) => {
      await tx.query(
        `insert into people (business_id, id, display_name) values ($1, $1, 'Early Example')`,
        [business],
      );
      await tx.query(
        `insert into actors (business_id, id, kind, person_id) values ($1, $1, 'person', $1)`,
        [business],
      );
      const owner = { person: business, actor: business, sub: 'earlier' };
      const { conversationId } = await conversationOf(tx, owner);
      const [call] = await tx.query<{ id: string }>(
        `insert into model_calls
           (business_id, id, conversation_id, operation_key, state, reserved_minor, route_key,
            route_reach, credential_kind, started_at, ended_at, actual_minor)
         values ($1, gen_random_uuid(), $2, 'conversation.answer', 'settled', 0, 'm5_ollama',
                 'local', 'api_key', clock_timestamp(), clock_timestamp(), 0)
         returning id`,
        [business, conversationId],
      );
      return { business, callId: String(call?.id), conversationId };
    });
    await db.closeSessions();
    await applyMigrations(db.admin, [...BEFORE, ...CARRIAGE]);
    alpha = await carriageBusiness(db.app, 'alpha');
    bravo = await carriageBusiness(db.app, 'bravo');
  }, 180_000);

  afterAll(async () => await db?.drop());

  it('applies over an earlier answered call, which keeps its row and names no message', async () => {
    expect(CARRIAGE.map((m) => m.version)).toHaveLength(4);
    const rows = await db.admin.execute<{ state: string; conversation_message_id: string | null }>(
      `select state, conversation_message_id from public.model_calls where id = $1`,
      [earlier.callId],
    );
    expect(rows).toEqual([{ state: 'settled', conversation_message_id: null }]);
  });

  it('a business reads only its own members and carriers', async () => {
    const seen = async (business: string, table: string) =>
      await db.app.withBusiness(business, async (tx) =>
        (await tx.query<{ business_id: string }>(`select business_id::text from ${table}`)).map(
          (row) => row.business_id,
        ),
      );
    for (const table of ['conversation_agent_members', 'model_call_carriers']) {
      // oxlint-disable-next-line no-await-in-loop -- two tables in turn
      expect(new Set(await seen(alpha.id, table))).toEqual(new Set([alpha.id]));
      // oxlint-disable-next-line no-await-in-loop -- two tables in turn
      expect(new Set(await seen(bravo.id, table))).toEqual(new Set([bravo.id]));
    }
  });

  it("refuses a row naming another business's agent, call or conversation", async () => {
    const refusal = async (write: Parameters<typeof db.app.withBusiness>[1]) =>
      await db.app.withBusiness(alpha.id, write).then(
        () => 'written',
        (cause: { code?: string }) => cause.code,
      );
    // Bravo's agent as a member of alpha's conversation: the key is (business, agent).
    expect(
      await refusal(async (tx) => {
        await openMembership(tx, alpha.conversationId, bravo.otherAgent, alpha.owner);
      }),
    ).not.toBe('written');
    // A carriers row for bravo's call, under alpha: no such call here.
    expect(
      await refusal(async (tx) => {
        await carriersRow(tx, bravo.callId, alpha.agent);
      }),
    ).not.toBe('written');
    // A row written as bravo's from alpha's transaction: refused before row security,
    // since bravo's agent is not visible from alpha.
    expect(
      await refusal(async (tx) => {
        await tx.query(
          `insert into conversation_agent_members
             (business_id, conversation_id, agent_actor_id, added_by_actor_id)
           values ($1, $2, $3, $4)`,
          [bravo.id, bravo.conversationId, bravo.agent.actor, bravo.owner.actor],
        );
      }),
    ).not.toBe('written');
  });

  it("refuses a call naming another conversation's message, and a second call on one message", async () => {
    const outcome = async (write: Parameters<typeof db.app.withBusiness>[1]) =>
      await db.app.withBusiness(alpha.id, write).then(
        () => 'written',
        (cause: { code?: string }) => cause.code,
      );
    expect(
      await outcome(async (tx) => {
        const one = await conversationOf(tx, alpha.owner);
        const other = await conversationOf(tx, alpha.owner);
        await dispatchedCall(tx, {
          conversationId: one.conversationId,
          messageId: other.messageId,
        });
      }),
    ).toBe('23503');
    expect(
      await outcome(async (tx) => {
        await dispatchedCall(tx, {
          conversationId: alpha.conversationId,
          messageId: alpha.messageId,
        });
      }),
    ).toBe('23505');
  });

  it('a carriers row is a dispatched conversation call’s, set once in order', async () => {
    const outcome = async (sql: string) =>
      await db.app
        .withBusiness(alpha.id, async (tx) => {
          await tx.query(sql, [alpha.id, alpha.callId]);
        })
        .then(
          () => 'written',
          (cause: { code?: string }) => cause.code,
        );
    // The send before the offer, and half of the send: refused.
    expect(
      await outcome(
        `update model_call_carriers set runner = gen_random_uuid(), request_at = now(),
                send_by = now(), answer_by = now() + interval '1 minute'
          where business_id = $1 and call_id = $2`,
      ),
    ).toBe('23514');
    expect(
      await outcome(
        `update model_call_carriers set offered_at = now(), runner = gen_random_uuid()
          where business_id = $1 and call_id = $2`,
      ),
    ).toBe('23514');
    // A second carriers row for the call.
    expect(
      await outcome(
        `insert into model_call_carriers (business_id, call_id, agent_actor_id)
         select business_id, call_id, agent_actor_id from model_call_carriers
          where business_id = $1 and call_id = $2`,
      ),
    ).toBe('23505');
  });
});
