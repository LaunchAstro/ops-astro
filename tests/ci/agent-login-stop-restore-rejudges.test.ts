// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent login tool's restore judges again under its locks: an actor grant
// of the operator's is held until the step commits, and a resumed restore
// refuses a credential revoked after its reservation.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isBusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import {
  lockAgentCredential,
  revokeAgentCredential,
} from '../../packages/core-records/src/authority/agent-credentials.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
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
});
