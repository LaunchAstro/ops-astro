// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent login tool resolves the operator again once it holds their
// grants: an operator whose membership ends while the make waits on their
// locked operations:manage grant is no longer the operator, and the make
// stops before it admits anything or writes an act. The grant stays live
// throughout, so only the membership's end can stop it.

import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { actsOf, agentOf, makeArgs, makeWorld, runAct, type World } from './agent-login.fixture.ts';

await import(new URL('../support/pooler-at-loopback.mjs', import.meta.url).href);
Reflect.set(globalThis, Symbol.for('ops-astro.test.plaintext-at-loopback'), true);
const serverUrl = databaseUrlFromEnvironment();
let world: World;

/** Resolves once a session of this database waits on a row of the grants table. */
async function waitingOnTheGrant(): Promise<void> {
  for (let tries = 0; tries < 400; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polled until the make waits
    const [row] = await world.db.admin.execute<{ n: number }>(
      `select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid = l.pid
        where not l.granted and a.datname = current_database() and a.query like '%public.grants%'`,
    );
    if ((row?.n ?? 0) > 0) return;
    // oxlint-disable-next-line no-await-in-loop -- polled until the make waits
    await delay(50);
  }
  throw new Error('no make waited on the operator grant');
}

async function membershipEndsDuringTheGrantWait(): Promise<void> {
  const agent = await agentOf(world);
  const plain = (world.env['DATABASE_ADMIN_URL'] ?? '').replace(/[?].*$/u, '?sslmode=disable');
  const holder = connectAsAdmin(plain, { source: 'harness' });
  try {
    const { started } = await holder.transaction(async (execute) => {
      await execute(
        `select id from public.grants where subject_id = $1 and collection = 'operations'
            and action = 'manage' and revoked_at is null for update`,
        [world.operatorPerson],
      );
      const make = runAct(world, { args: makeArgs(agent) });
      await Promise.race([waitingOnTheGrant(), make]);
      await world.db.admin.execute(
        'update public.memberships set active = false, ended_at = now() where person_id = $1',
        [world.operatorPerson],
      );
      return { started: make };
    });
    const result = await started;
    expect(result.printed).toContain('no longer the operator');
    expect(result.status).toBe(1);
    expect(await actsOf(world, agent)).toHaveLength(0);
    const [grant] = await world.db.admin.execute<{ live: boolean }>(
      `select revoked_at is null as live from public.grants
        where subject_id = $1 and collection = 'operations' and action = 'manage'`,
      [world.operatorPerson],
    );
    expect(grant).toEqual({ live: true });
  } finally {
    await holder.close();
    await world.db.admin.execute(
      'update public.memberships set active = true, ended_at = null where person_id = $1',
      [world.operatorPerson],
    );
  }
}

describe.skipIf(serverUrl === undefined)(
  'agent login: the operator resolved after the grant wait',
  () => {
    beforeAll(async () => {
      world = await makeWorld(serverUrl ?? '');
    }, 60_000);
    afterAll(async () => await world?.close());

    it(
      'an-operator-whose-membership-ends-during-the-grant-wait-writes-no-act',
      membershipEndsDuringTheGrantWait,
      30_000,
    );
  },
);
