// SPDX-License-Identifier: AGPL-3.0-only
//
// An operator whose membership ends while a make waits on their locked
// operations:manage grant writes no act and makes no provider call: the
// operator is resolved again once the grant is held.
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { actsOf, agentOf, makeArgs, makeWorld, runAct, type World } from './agent-login.fixture.ts';
import { providerUsers } from './agent-login-provider.fixture.ts';

await import(new URL('../support/pooler-at-loopback.mjs', import.meta.url).href);
Reflect.set(globalThis, Symbol.for('ops-astro.test.plaintext-at-loopback'), true);
const serverUrl = databaseUrlFromEnvironment();
let world: World;
const users = providerUsers();

async function waitingOnGrant(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polled until the make waits
    const [row] = await world.db.admin.execute<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock'
         and query like '%public.grants%'`,
    );
    if ((row?.n ?? 0) > 0) return;
    // oxlint-disable-next-line no-await-in-loop -- polled until the make waits
    await delay(25);
  }
  throw new Error('operator never waited on its grant lock');
}

async function membershipEndsDuringTheGrantLockWait(): Promise<void> {
  const agent = await agentOf(world);
  const calls = world.provider.calls.length;
  const holder = connectAsAdmin(
    (world.env['DATABASE_ADMIN_URL'] ?? '').replace(/sslmode=require/u, 'sslmode=disable'),
  );
  let pending: ReturnType<typeof runAct> | undefined;
  try {
    await holder.transaction(async (execute) => {
      await execute(
        "select id from public.grants where business_id = $1 and subject_id = $2 and collection = 'operations' for update",
        [world.alpha, world.operatorPerson],
      );
      pending = runAct(world, { args: makeArgs(agent) });
      const reached = await Promise.race([
        waitingOnGrant().then(() => 'waiting'),
        pending.then(() => 'finished'),
      ]);
      expect(reached, 'the operator must wait on its grant lock').toBe('waiting');
      await world.db.admin.execute(
        'update public.memberships set active = false, ended_at = clock_timestamp() where business_id = $1 and person_id = $2',
        [world.alpha, world.operatorPerson],
      );
    });
    const result = await pending;
    expect(result?.status).toBe(1);
    expect(result?.printed).toContain('no longer the operator');
    expect(
      await actsOf(world, agent),
      'operator membership ended before admission but a reserved act committed',
    ).toHaveLength(0);
    expect(world.provider.calls.slice(calls)).toEqual([]);
  } finally {
    await pending;
    await holder.close();
  }
}

describe.skipIf(serverUrl === undefined)(
  'agent login: the operator after the grant lock wait',
  () => {
    beforeAll(async () => {
      world = await makeWorld(serverUrl ?? '', users.handle);
      users.world = world;
    }, 60_000);
    afterAll(async () => await world?.close());

    it(
      'an-operator-membership-ended-during-the-grant-lock-wait-writes-no-act',
      membershipEndsDuringTheGrantLockWait,
      30_000,
    );
  },
);
