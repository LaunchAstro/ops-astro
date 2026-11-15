// SPDX-License-Identifier: AGPL-3.0-only
//
// A delegation's expiry is judged when the judgement runs, after any lock it
// waited on, never at the transaction's start. Each case begins its
// transaction while the delegation is live, lets the database clock pass its
// expiry (holding its row on a connection of its own where the judgement
// waits on a lock), and expects the delegation to be judged expired.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import {
  mintChildDelegation,
  mintDelegation,
  resolveDelegation,
  resolveLiveById,
  resolveNarrowedDelegation,
  type Delegation,
} from '../../packages/core-records/src/authority/delegations.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { serverUrl } from '../acceptance/world.ts';
import { holdRow, instantOf, waiterOf, waitPast } from '../support/lock-wait-race.ts';

let harness: Harness;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  harness = await createHarness('delegation_expiry_after_wait');
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

/** A delegation from Ada to the world's agent on the shared task, ending `seconds` from now. */
async function shortDelegation(seconds: number): Promise<Delegation> {
  const { world } = harness;
  const minted = await world.db.app.withBusiness(
    world.alpha,
    async (tx) =>
      await mintDelegation(tx, {
        agentActorId: String(world.agent.actorId),
        delegatePersonId: String(world.ada.personId),
        mintedByActorId: String(world.ada.actorId),
        purpose: `expiry_after_wait_${randomUUID().slice(0, 8)}`,
        collections: ['task', 'run'],
        actions: ['read', 'write'],
        purposeScope: { kind: 'record', id: harness.alphaTask.id },
        expiresAt: new Date(Date.now() + seconds * 1000),
      }),
  );
  if (!minted.ok) throw new Error(`the delegation was refused ${minted.refusal.code}`);
  return minted.value.delegation;
}

const expiryOf = async (id: string): Promise<string> =>
  await instantOf(
    harness.world.db,
    'select expires_at::text as at from public.delegations where id = $1',
    [id],
  );

/** Run `act` in a transaction on its own connection that began before `deadline`. */
async function beganBefore<T>(act: (tx: TenantQuery) => Promise<T>): Promise<T> {
  const { world } = harness;
  return await world.db.app.withBusiness(world.alpha, act);
}

const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

it('a replay looking a delegation up by id finds none once it has expired', async () => {
  const delegation = await shortDelegation(2);
  const deadline = await expiryOf(delegation.id);
  const found = await beganBefore(async (tx) => {
    await tx.query('select 1');
    await waitPast(harness.world.db, deadline);
    return await resolveLiveById(tx, String(harness.world.agent.actorId), delegation.id);
  });
  expect(found).toBeUndefined();
});

it('revoking a delegation that expired while the revocation waited on its row is refused', async () => {
  const delegation = await shortDelegation(3);
  const deadline = await expiryOf(delegation.id);
  const held = await holdRow(
    harness.world.db,
    'select id from public.delegations where id = $1 for update',
    [delegation.id],
  );
  try {
    const revoking = harness.asPerson('delegation.revoke', { delegationId: delegation.id });
    revoking.catch(() => null);
    const began = await waiterOf(harness.world.db, held);
    expect(began < deadline, 'the revocation began while the delegation was live').toBe(true);
    await waitPast(harness.world.db, deadline);
    await held.letGo();
    const answer = await revoking;
    const [row] = await harness.world.db.admin.execute<{ readonly revoked: boolean }>(
      'select revoked_at is not null as revoked from public.delegations where id = $1',
      [delegation.id],
    );
    expect({ code: answer.code, revoked: row?.revoked }).toEqual({
      code: 'DELEGATION_NOT_LIVE',
      revoked: false,
    });
  } finally {
    await held.letGo();
  }
});

it('a child is not minted under a parent that expired while the mint waited on its row', async () => {
  const parent = await shortDelegation(3);
  const deadline = await expiryOf(parent.id);
  const helper = randomUUID();
  await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
    await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      tx.businessId,
      helper,
    ]);
  });
  const held = await holdRow(
    harness.world.db,
    'select id from public.delegations where id = $1 for update',
    [parent.id],
  );
  try {
    const minting = beganBefore(
      async (tx) =>
        await mintChildDelegation(tx, parent, {
          agentActorId: helper,
          purpose: `helper_${randomUUID().slice(0, 8)}`,
          collections: ['task'],
          actions: ['read'],
          expiresAt: new Date(Date.parse(deadline)),
        }),
    );
    minting.catch(() => null);
    const began = await waiterOf(harness.world.db, held);
    expect(began < deadline, 'the mint began while the parent was live').toBe(true);
    await waitPast(harness.world.db, deadline);
    await held.letGo();
    const minted = await minting;
    expect(minted.ok ? 'minted' : minted.refusal.code).toBe('DELEGATION_EXPIRED');
  } finally {
    await held.letGo();
  }
});

it('a delegation answered narrowed is still found narrowed after it expires later in the same transaction', async () => {
  const { world } = harness;
  const task = { kind: 'record' as const, id: harness.alphaTask.id };
  const minted = await world.db.app.withBusiness(
    world.alpha,
    async (tx) =>
      await mintDelegation(tx, {
        agentActorId: String(world.agent.actorId),
        delegatePersonId: String(world.mia.personId),
        mintedByActorId: String(world.mia.actorId),
        purpose: `narrowed_${randomUUID().slice(0, 8)}`,
        collections: ['task'],
        actions: ['write'],
        purposeScope: task,
        expiresAt: new Date(Date.now() + 2000),
      }),
  );
  if (!minted.ok) throw new Error(`the delegation was refused ${minted.refusal.code}`);
  const { delegation, credential } = minted.value;
  // Mia's write lapses: the delegation stays live and draws on nothing.
  await world.db.admin.execute(
    `update public.grants set revoked_at = greatest(now(), granted_at)
          where collection = 'task' and action = 'write' and revoked_at is null
            and (subject_id = $1 or subject_id = $2)`,
    [world.mia.personId, world.mia.actorId],
  );
  const deadline = await expiryOf(delegation.id);
  const agent = String(world.agent.actorId);
  const found = await beganBefore(async (tx) => {
    const live = await resolveDelegation(tx, agent, credential);
    expect(live.ok, 'the delegation is live when first resolved').toBe(true);
    await waitPast(world.db, deadline);
    return await resolveNarrowedDelegation(tx, agent, credential, {
      collection: 'task',
      action: 'write',
      scope: task,
    });
  });
  expect(found).toEqual({ id: delegation.id });
});
