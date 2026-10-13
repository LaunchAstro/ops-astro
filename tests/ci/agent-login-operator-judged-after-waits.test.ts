// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent login tool judges the operator's sign-in again after it waits on
// the agent's lock: a bearer that expires, or a session that passes its
// absolute limit, while the make waits is no longer the operator's, and the
// make stops before any write or provider call. The same bearer is refused
// by the operator gate afterwards, as an independent control. And every grant
// the gate accepts, the operator's actor's as well as the person's, is held
// for share until the step commits: its revocation waits.
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { connectAsAdmin, isBusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import { requireOperator } from '../../scripts/ops/operator.ts';
import { SESSION_ABSOLUTE_SECONDS } from '../../packages/core-records/src/identity/verified-subject.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { signBearer } from '../support/sign-in.ts';
import { agentOf, makeArgs, makeWorld, runAct, type World } from './agent-login.fixture.ts';
import { holdingTheAgent } from './agent-login-provider.fixture.ts';

await import(new URL('../support/pooler-at-loopback.mjs', import.meta.url).href);
Reflect.set(globalThis, Symbol.for('ops-astro.test.plaintext-at-loopback'), true);
const serverUrl = databaseUrlFromEnvironment();
let world: World;

async function bearerExpires(): Promise<void> {
  const original = JSON.parse(
    Buffer.from(world.env['OPS_ASTRO_TOKEN']!.split('.')[1]!, 'base64url').toString(),
  );
  const exp = Math.floor(Date.now() / 1000) + 5;
  const token = await signBearer({ ...original, exp });
  const env = { OPS_ASTRO_TOKEN: token };
  const agent = await agentOf(world);
  const result = await holdingTheAgent(
    world,
    agent,
    async () => {
      await delay(Math.max(0, (exp + 1) * 1000 - Date.now()));
    },
    async () => await runAct(world, { args: makeArgs(agent), env }),
  );
  // Independent control: exactly the same bearer is now rejected by the real gate.
  const plain: Record<string, string> = { ...world.env, ...env };
  for (const name of ['DATABASE_ADMIN_URL', 'DATABASE_URL']) {
    const url = new URL(plain[name]!);
    url.searchParams.set('sslmode', 'disable');
    plain[name] = url.toString();
  }
  const expired = await requireOperator(plain);
  expect(expired.ok).toBe(false);
  expect(!expired.ok && expired.reason).toContain('expired');
  expect(result.printed).toContain('no longer the operator');
}

async function sessionLimitPasses(): Promise<void> {
  const original = JSON.parse(
    Buffer.from(world.env['OPS_ASTRO_TOKEN']!.split('.')[1]!, 'base64url').toString(),
  );
  const signedInAt = Math.floor(Date.now() / 1000) - SESSION_ABSOLUTE_SECONDS + 5;
  const token = await signBearer({
    ...original,
    amr: [{ method: 'password', timestamp: signedInAt }],
  });
  const env = { OPS_ASTRO_TOKEN: token };
  const agent = await agentOf(world);
  const result = await holdingTheAgent(
    world,
    agent,
    async () => {
      await delay(Math.max(0, (signedInAt + SESSION_ABSOLUTE_SECONDS + 2) * 1000 - Date.now()));
    },
    async () => await runAct(world, { args: makeArgs(agent), env }),
  );
  const plain: Record<string, string> = { ...world.env, ...env };
  for (const name of ['DATABASE_ADMIN_URL', 'DATABASE_URL']) {
    const url = new URL(plain[name]!);
    url.searchParams.set('sslmode', 'disable');
    plain[name] = url.toString();
  }
  const expired = await requireOperator(plain);
  expect(expired.ok).toBe(false);
  expect(!expired.ok && expired.reason).toContain('expired');
  expect(result.printed).toContain('no longer the operator');
}

/** An actor grant of the operator's, the only one standing: their person grant is revoked. */
async function actorGrantOnly(): Promise<string> {
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
  return issued.value;
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

/** Inside the make's step, after its authority hold: the actor grant's revocation must wait. */
async function actorGrantHeld(): Promise<void> {
  const grant = await actorGrantOnly();
  const agent = await agentOf(world);
  const plainAdmin = (world.env['DATABASE_ADMIN_URL'] ?? '').replace(/[?].*$/u, '?sslmode=disable');
  const holder = connectAsAdmin(plainAdmin, { source: 'harness' });
  let committedBeforeAct = false;
  let revocation: Promise<unknown> | undefined;
  try {
    const make = await holder.transaction(async (execute) => {
      // The agent's row, held so the step waits on it after its authority hold.
      await execute('select 1 from public.actors where id = $1 for update', [agent]);
      const started = runAct(world, { args: makeArgs(agent) });
      await Promise.race([waitingOnARow(), started]);
      let committed = false;
      revocation = world.db.admin
        .execute('update public.grants set revoked_at = clock_timestamp() where id = $1', [grant])
        .then(() => {
          committed = true;
          return committed;
        });
      await Promise.race([revocation, delay(300)]);
      committedBeforeAct = committed;
      return { started };
    });
    await make.started;
    await revocation;
    expect(committedBeforeAct, 'the grant revocation committed inside the open step').toBe(false);
  } finally {
    await revocation;
    await holder.close();
    await world.db.admin.execute(
      "update public.grants set revoked_at = null where subject_id = $1 and collection = 'operations'",
      [world.operatorPerson],
    );
    await world.db.admin.execute(
      'update public.grants set revoked_at = coalesce(revoked_at, clock_timestamp()) where id = $1',
      [grant],
    );
  }
}

describe.skipIf(serverUrl === undefined)('agent login: the operator judged after waits', () => {
  beforeAll(async () => {
    world = await makeWorld(serverUrl ?? '');
  }, 60_000);
  afterAll(async () => {
    await world?.close();
  });

  it('a-bearer-expiring-during-the-agent-lock-wait-is-refused-at-admission', bearerExpires, 30_000);
  it(
    'the-absolute-session-limit-passing-during-the-agent-lock-wait-is-refused-at-admission',
    sessionLimitPasses,
    30_000,
  );
  it('an-actor-operations-grant-stays-held-until-the-step-commits', actorGrantHeld, 60_000);
});
