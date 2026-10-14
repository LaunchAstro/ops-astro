// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent login tool's stop and restore judge again under their locks: an
// actor grant of the operator's is held until the step commits; a resumed
// restore refuses a credential revoked after its reservation; a stop bans
// every live login of the agent that is not shared; and a ban waiting on its
// receipt makes no provider call once the operator's bearer has expired.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAsAdmin, isBusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import {
  lockAgentCredential,
  revokeAgentCredential,
} from '../../packages/core-records/src/authority/agent-credentials.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { signBearer } from '../support/sign-in.ts';
import { made } from './agent-login-acts.fixture.ts';
import {
  actsOf,
  agentOf,
  makeArgs,
  makeWorld,
  mappingsOf,
  runAct,
  secret,
  type World,
} from './agent-login.fixture.ts';
import { providerUsers } from './agent-login-provider.fixture.ts';

await import(new URL('../support/pooler-at-loopback.mjs', import.meta.url).href);
Reflect.set(globalThis, Symbol.for('ops-astro.test.plaintext-at-loopback'), true);
const serverUrl = databaseUrlFromEnvironment();
let world: World;
const users = providerUsers();

async function seedCredential(agent: string): Promise<string> {
  const id = randomUUID();
  await world.db.admin.transaction(async (execute) => {
    await execute('set local session_replication_role = replica');
    await execute(
      `insert into public.agent_credentials (business_id, id, agent_actor_id, issued_by_person_id,
         issued_by_actor_id, purpose, scope, credential_hash, credential_scheme,
         credential_key_id, expires_at)
       values ($1, $2, $3, $4, $5, 'task_work', '{task:read}', repeat('b', 64),
         'hmac-sha256-v1', 'k1', now() + interval '1 day')`,
      [world.alpha, id, agent, world.ownerPerson, world.ownerActor],
    );
  });
  return id;
}

/** An actor grant of the operator's, standing alone: their person grant is revoked. */
async function issueActorGrantOnly(): Promise<{ value: string }> {
  const [operatorActor] = await world.db.admin.execute<{ id: string }>(
    "select id from public.actors where business_id = $1 and person_id = $2 and kind = 'person' and active",
    [world.alpha, world.operatorPerson],
  );
  if (operatorActor === undefined || !isBusinessId(world.alpha))
    throw new Error('operator setup invalid');
  const issued = await world.db.app.withBusiness(world.alpha, async (tx) => {
    const grant = await issueGrant(tx, [{ kind: 'actor', id: operatorActor.id }], {
      subject: { kind: 'actor', id: operatorActor.id },
      scope: { kind: 'business', id: null },
      collection: 'operations',
      action: 'manage',
      parentGrantId: null,
      grantedByActorId: operatorActor.id,
    });
    await tx.query(
      "update public.grants set revoked_at = clock_timestamp() where subject_id = $1 and collection = 'operations'",
      [world.operatorPerson],
    );
    return grant;
  });
  if (!issued.ok) throw new Error('actor grant refused');
  return issued;
}

async function actorGrantHeld(): Promise<void> {
  const issued = await issueActorGrantOnly();
  let committedBeforeAct = false;
  let revocation: Promise<unknown> | undefined;
  try {
    const agent = await agentOf(world);
    await runAct(world, {
      args: makeArgs(agent),
      password: secret(),
      at: async (point) => {
        if (point !== 'reserve') return;
        // This point is inside the acting transaction, after its authority hold.
        let committed = false;
        revocation = world.db.admin
          .execute('update public.grants set revoked_at = clock_timestamp() where id = $1', [
            issued.value,
          ])
          .then(() => {
            committed = true;
            return committed;
          });
        await Promise.race([revocation, delay(300)]);
        committedBeforeAct = committed;
      },
    });
    await revocation;
    expect(
      committedBeforeAct,
      'the grant revocation committed inside the still-open acting transaction',
    ).toBe(false);
  } finally {
    await revocation;
    await world.db.admin.execute(
      "update public.grants set revoked_at = null where subject_id = $1 and collection = 'operations'",
      [world.operatorPerson],
    );
    await world.db.admin.execute(
      'update public.grants set revoked_at = coalesce(revoked_at, clock_timestamp()) where id = $1',
      [issued.value],
    );
  }
}

async function resumedRestoreRefusesARevokedCredential(): Promise<void> {
  const { agent, email } = await made(world);
  const credential = await seedCredential(agent);
  expect((await runAct(world, { args: ['stop', '--agent', agent] })).status).toBe(0);
  const args = ['restore', ...makeArgs(agent, email).slice(1)];
  const password = secret();
  const interrupted = await runAct(world, {
    args,
    password,
    at: async (point) =>
      await (point === 'reserved'
        ? Promise.reject(new Error('interrupted after committed reservation'))
        : Promise.resolve()),
  });
  expect(interrupted.status).toBe(1);
  expect((await actsOf(world, agent)).at(-1)).toMatchObject({
    act: 'restore',
    phase: 'reserved',
  });
  if (!isBusinessId(world.alpha)) throw new Error('business setup invalid');
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    const held = await lockAgentCredential(tx, credential);
    if (held === undefined) throw new Error('credential setup absent');
    expect(await revokeAgentCredential(tx, held, world.ownerActor)).toBeUndefined();
  });
  const resumed = await runAct(world, { args, password });
  expect(resumed.status, resumed.printed).toBe(1);
  expect(await mappingsOf(world, agent)).toHaveLength(0);
}

async function stopBansEveryLiveLogin(): Promise<void> {
  const { agent, subject } = await made(world);
  const secondSubject = randomUUID();
  users.list.push({
    id: secondSubject,
    email: `other-${randomUUID()}@example.test`,
    password: secret(),
    app_metadata: {},
  });
  await world.db.admin.execute(
    `with l as (insert into public.logins (business_id, id, provider, subject)
                values ($1, gen_random_uuid(), 'supabase', $2) returning id)
     insert into public.actor_logins (business_id, id, login_id, actor_id, active, linked_by_actor_id)
     select $1, gen_random_uuid(), l.id, $3, true, $4 from l`,
    [world.alpha, secondSubject, agent, world.ownerActor],
  );
  expect(await mappingsOf(world, agent)).toHaveLength(2);
  const stopped = await runAct(world, { args: ['stop', '--agent', agent] });
  expect(stopped.status, stopped.printed).toBe(0);
  expect(await mappingsOf(world, agent)).toHaveLength(0);
  const banned = users.list.filter(
    (user) => [subject, secondSubject].includes(user.id) && user.banned_until !== undefined,
  );
  expect(banned.map((user) => user.id).toSorted(), stopped.printed).toEqual(
    [subject, secondSubject].toSorted(),
  );
}

/** The ban of an owed receipt waits on the receipt's row; the operator's bearer expires meanwhile. */
async function banAfterTheBearerExpired(): Promise<void> {
  const { agent, subject } = await made(world);
  users.down = true;
  expect((await runAct(world, { args: ['stop', '--agent', agent] })).status).toBe(1);
  users.down = false;
  const original = JSON.parse(
    Buffer.from((world.env['OPS_ASTRO_TOKEN'] ?? '').split('.')[1] ?? '', 'base64url').toString(),
  ) as Record<string, unknown>;
  const exp = Math.floor(Date.now() / 1000) + 4;
  const token = await signBearer({ ...original, exp });
  const plain = (world.env['DATABASE_ADMIN_URL'] ?? '').replace(/[?].*$/u, '?sslmode=disable');
  const holder = connectAsAdmin(plain, { source: 'harness' });
  try {
    const run = await holder.transaction(async (execute) => {
      await execute(
        "select id from ops.agent_login_acts where agent_actor_id = $1 and act = 'stop' for update",
        [agent],
      );
      const started = runAct(world, {
        args: ['stop', '--agent', agent],
        env: { OPS_ASTRO_TOKEN: token },
      });
      await Promise.race([waitingOnARow(), started]);
      await delay(Math.max(0, (exp + 1) * 1000 - Date.now()));
      return { started };
    });
    const result = await run.started;
    expect(result.printed).toContain('no longer the operator');
    expect(result.status).toBe(1);
    expect(users.list.find((user) => user.id === subject)?.banned_until).toBeUndefined();
  } finally {
    await holder.close();
  }
}

/** Resolves once a session of this database waits on a row lock. */
async function waitingOnARow(): Promise<void> {
  for (let tries = 0; tries < 400; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polled until a run waits
    const [row] = await world.db.admin.execute<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
    );
    if ((row?.n ?? 0) > 0) return;
    // oxlint-disable-next-line no-await-in-loop -- polled until a run waits
    await delay(50);
  }
  throw new Error('no run waited on a row');
}

describe.skipIf(serverUrl === undefined)('agent login: stop and restore judge again', () => {
  beforeAll(async () => {
    world = await makeWorld(serverUrl ?? '', users.handle);
    users.world = world;
  }, 60_000);
  afterAll(async () => await world?.close());

  it(
    'an-actor-operations-grant-stays-held-until-the-acting-transaction-commits',
    actorGrantHeld,
    60_000,
  );
  it(
    'a-resumed-restore-refuses-a-credential-revoked-after-reservation',
    resumedRestoreRefusesARevokedCredential,
    60_000,
  );
  it('stop-bans-every-non-shared-live-login-of-the-agent', stopBansEveryLiveLogin, 60_000);
  it(
    'a-ban-waiting-on-its-receipt-makes-no-provider-call-once-the-bearer-expired',
    banAfterTheBearerExpired,
    60_000,
  );
});
