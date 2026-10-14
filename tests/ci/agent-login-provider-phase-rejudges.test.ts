// SPDX-License-Identifier: AGPL-3.0-only
//
// The make's provider phase judges again, under its own locks, what the make
// was admitted on: an operator bearer that expired during a wait writes no act
// and makes no provider user, and a live login installed on the agent after
// reservation stops the make before any provider call, so no orphan user is
// left behind for bind to refuse.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { signBearer } from '../support/sign-in.ts';
import {
  actsOf,
  agentOf,
  makeArgs,
  makeWorld,
  runAct,
  waitingOnTheLock,
  type World,
} from './agent-login.fixture.ts';
import { providerUsers } from './agent-login-provider.fixture.ts';

await import(new URL('../support/pooler-at-loopback.mjs', import.meta.url).href);
Reflect.set(globalThis, Symbol.for('ops-astro.test.plaintext-at-loopback'), true);
const serverUrl = databaseUrlFromEnvironment();
let world: World;
const users = providerUsers();

function deferred() {
  const gate = { resolve: (): void => {} };
  const promise = new Promise<void>((done) => {
    gate.resolve = done;
  });
  return { promise, resolve: () => gate.resolve() };
}

async function waitsOnAgentRow() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polled until the phase waits
    const [row] = await world.db.admin.execute<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and query like 'select kind, active, display_name, owner_person_id%from public.actors%'`,
    );
    if ((row?.n ?? 0) > 0) return;
    // oxlint-disable-next-line no-await-in-loop -- polled until the phase waits
    await delay(25);
  }
  throw new Error('the provider phase never waited on the agent row');
}

/** An operator bearer of the operator's own subject and session, expiring at `exp`. */
async function bearerUntil(exp: number): Promise<string> {
  const [login] = await world.db.admin.execute<{ subject: string }>(
    `select l.subject from public.logins l join public.person_logins p
     on p.business_id = l.business_id and p.login_id = l.id
     where p.business_id = $1 and p.person_id = $2 and p.active`,
    [world.alpha, world.operatorPerson],
  );
  return await signBearer({
    sub: login?.subject,
    aud: 'authenticated',
    iss: world.env['GOTRUE_URL'],
    role: 'authenticated',
    exp,
    session_id: world.operatorSession,
  });
}

async function expiredAtTheAgentLock(): Promise<void> {
  const agent = await agentOf(world);
  const exp = Math.floor(Date.now() / 1000) + 3;
  const token = await bearerUntil(exp);
  const holder = connectAsAdmin(
    (world.env['DATABASE_ADMIN_URL'] ?? '').replace(/sslmode=require/u, 'sslmode=disable'),
  );
  let pending: ReturnType<typeof runAct> | undefined;
  try {
    await holder.transaction(async (execute) => {
      await execute('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `agent-login:${world.alpha}:${agent}`,
      ]);
      pending = runAct(world, { args: makeArgs(agent), env: { OPS_ASTRO_TOKEN: token } });
      const reached = await Promise.race([
        waitingOnTheLock(world).then(() => 'waiting'),
        pending.then(() => 'finished'),
      ]);
      expect(reached, 'the operator must actually wait on this database lock').toBe('waiting');
      await delay(Math.max(0, (exp + 1) * 1000 - Date.now()));
    });
    const result = await pending;
    expect(result?.status).toBe(1);
    expect(
      await actsOf(world, agent),
      'an expired operator reserved an act after the lock wait',
    ).toHaveLength(0);
  } finally {
    await pending;
    await holder.close();
  }
}

/** The bearer expires while the provider phase waits on the agent's row: no provider user. */
async function expiredAtTheAgentRow(): Promise<void> {
  const agent = await agentOf(world);
  const calls = world.provider.calls.length;
  const exp = Math.floor(Date.now() / 1000) + 4;
  const token = await bearerUntil(exp);
  const holder = connectAsAdmin(
    (world.env['DATABASE_ADMIN_URL'] ?? '').replace(/sslmode=require/u, 'sslmode=disable'),
  );
  const [taken, released] = [deferred(), deferred()];
  let hold: Promise<void> | undefined;
  const run = runAct(world, {
    args: makeArgs(agent),
    env: { OPS_ASTRO_TOKEN: token },
    at: async (point) => {
      if (point !== 'reserved') return;
      hold = holder.transaction(async (execute) => {
        await execute(
          'select id from public.actors where business_id = $1 and id = $2 for update',
          [world.alpha, agent],
        );
        taken.resolve();
        await released.promise;
      });
      await Promise.race([taken.promise, hold]);
    },
  });
  try {
    await Promise.race([taken.promise, run]);
    await Promise.race([waitsOnAgentRow(), run]);
    await delay(Math.max(0, (exp + 1) * 1000 - Date.now()));
    released.resolve();
    await hold;
    const result = await run;
    expect(result.printed).toContain('no longer the operator');
    expect(result.status).toBe(1);
    expect(world.provider.calls.slice(calls), 'an expired operator made a provider user').toEqual(
      [],
    );
  } finally {
    released.resolve();
    await hold;
    await run;
    await holder.close();
  }
}

async function foreignLoginAfterReservation(): Promise<void> {
  const agent = await agentOf(world);
  const calls = world.provider.calls.length;
  const result = await runAct(world, {
    args: makeArgs(agent),
    at: async (point) => {
      if (point !== 'reserved') return;
      await world.db.admin.execute(
        `with l as (insert into public.logins (business_id, id, provider, subject)
        values ($1, gen_random_uuid(), 'supabase', $2) returning id)
       insert into public.actor_logins (business_id, id, login_id, actor_id, active, linked_by_actor_id)
       select $1, gen_random_uuid(), l.id, $3, true, $4 from l`,
        [world.alpha, randomUUID(), agent, world.ownerActor],
      );
    },
  });
  expect(result.status).toBe(1);
  expect(result.printed).toContain('live login');
  expect(
    world.provider.calls.slice(calls),
    'admission changed but the provider phase still created a user',
  ).toEqual([]);
}

describe.skipIf(serverUrl === undefined)('agent login: the provider phase judges again', () => {
  beforeAll(async () => {
    world = await makeWorld(serverUrl ?? '', users.handle);
    users.world = world;
  }, 60_000);
  afterAll(async () => await world?.close());

  it(
    'an-operator-bearer-expired-during-the-agent-lock-wait-writes-no-act',
    expiredAtTheAgentLock,
    30_000,
  );
  it(
    'an-operator-bearer-expired-during-the-provider-phase-row-wait-makes-no-provider-user',
    expiredAtTheAgentRow,
    30_000,
  );
  it(
    'a-foreign-live-login-installed-after-reservation-prevents-provider-creation',
    foreignLoginAfterReservation,
    30_000,
  );
});
