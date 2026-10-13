// SPDX-License-Identifier: AGPL-3.0-only
//
// Where Realtime is installed (the shim, standing where a hosted project
// stands), the migrations write two policies on `realtime.messages` for the
// `authenticated` role, each asking the one join function: receive on any
// carriage topic, send on a call topic only. A send on a doorbell is refused
// even to the doorbell's own agent: only the database rings it. Where Realtime
// is absent (the migrated template, plain Postgres), the same migrations apply
// and write the function alone.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { createRealtimeDatabase, type RealtimeDatabase } from '../support/realtime-database.ts';
import {
  callTopic,
  carriageBusiness,
  doorbellTopic,
  type CarriageBusiness,
} from './carriage-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Policy {
  readonly policyname: string;
  readonly cmd: string;
  readonly roles: string;
  readonly qual: string | null;
  readonly with_check: string | null;
}

const policiesOn = async (admin: AdminConnection) =>
  await admin.execute<Policy>(
    `select policyname, cmd, roles::text, qual, with_check from pg_policies
      where schemaname = 'realtime' and tablename = 'messages' order by policyname`,
  );

/** A WebSocket send's authorisation, as Realtime asks it: an insert as the sender, the topic set. */
async function send(admin: AdminConnection, topic: string, sub: string): Promise<'sent' | string> {
  try {
    await admin.transaction(async (execute) => {
      await execute('set local role authenticated');
      await execute(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub })]);
      await execute(`select set_config('realtime.topic', $1, true)`, [topic]);
      await execute(
        `insert into realtime.messages (topic, extension, event, payload, private)
         values ($1, 'broadcast', 'piece', '{}'::jsonb, true)`,
        [topic],
      );
      // Authorised and then rolled back: Realtime stores no WebSocket broadcast.
      throw new Error('sent');
    });
  } catch (cause) {
    const { code, message } = cause as { code?: string; message?: string };
    return message === 'sent' ? 'sent' : (code ?? 'unknown');
  }
  return 'unknown';
}

// eslint-disable-next-line max-lines-per-function -- two databases, one with Realtime and one without
describe.skipIf(serverUrl === undefined)('the carriage policies on realtime.messages', () => {
  let hosted: RealtimeDatabase;
  let plain: FreshDatabase;
  let alpha: CarriageBusiness;

  beforeAll(async () => {
    hosted = await createRealtimeDatabase('carriage_policies');
    plain = await createFreshDatabase({ part: 'carriage_no_realtime' });
    alpha = await carriageBusiness(hosted.app, 'alpha');
  }, 240_000);

  afterAll(async () => {
    await hosted?.drop();
    await plain?.drop();
  });

  it('with Realtime, receive and send each ask the one join function, send on a call topic only', async () => {
    const policies = await policiesOn(hosted.admin);
    expect(policies.map((one) => [one.policyname, one.cmd, one.roles])).toStrictEqual([
      ['ops_carry_receive', 'SELECT', '{authenticated}'],
      ['ops_carry_send', 'INSERT', '{authenticated}'],
    ]);
    const [receive, sending] = policies;
    expect(receive?.qual).toContain('ops_carry_may_join(realtime.topic())');
    expect(receive?.qual).toContain("extension = 'broadcast'");
    expect(sending?.with_check).toContain('ops_carry_may_join(realtime.topic())');
    expect(sending?.with_check).toContain('carry:%:call:%');
  });

  it('a send is admitted on the call topic and refused on a doorbell, its own agent included', async () => {
    expect(await send(hosted.admin, callTopic(alpha.id, alpha.callId), alpha.owner.sub)).toBe(
      'sent',
    );
    expect(await send(hosted.admin, callTopic(alpha.id, alpha.callId), alpha.agent.sub)).toBe(
      'sent',
    );
    // Row security refuses the row (42501): another person, and anyone on a doorbell.
    expect(await send(hosted.admin, callTopic(alpha.id, alpha.callId), alpha.colleague.sub)).toBe(
      '42501',
    );
    const bell = doorbellTopic(alpha.id, alpha.agent.actor);
    expect(await send(hosted.admin, bell, alpha.agent.sub)).toBe('42501');
    expect(await send(hosted.admin, bell, alpha.owner.sub)).toBe('42501');
  });

  it('without Realtime, the migrations apply and write the join function and no policy', async () => {
    const [found] = await plain.admin.execute<{
      readonly realtime: string | null;
      fn: string | null;
    }>(
      `select to_regnamespace('realtime')::text as realtime,
              to_regprocedure('public.ops_carry_may_join(text)')::text as fn`,
    );
    expect(found).toStrictEqual({ realtime: null, fn: 'ops_carry_may_join(text)' });
    expect(
      await plain.admin.execute(`select 1 from pg_policies where schemaname = 'realtime'`),
    ).toHaveLength(0);
  });
});
