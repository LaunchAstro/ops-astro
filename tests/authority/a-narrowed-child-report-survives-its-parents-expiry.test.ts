// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one race proof: mint, narrow, wait past the parent's expiry, report */
//
// #1030 for a child delegation. A child whose parent's grants were cut answers
// DELEGATION_NARROWED; the late report that follows in the same transaction
// looks the child up again with resolveNarrowedDelegation. If the parent's
// expiry passes between the two, the report must still find the child: its
// expiry is judged no later than the narrowed answer before it, the parent's
// as well as the child's own.

import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { credentialKeyring } from '../../packages/core-records/src/authority/credential-keys.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import {
  checkDelegatedAuthority,
  mintChildDelegation,
  mintDelegation,
  resolveDelegation,
  resolveNarrowedDelegation,
} from '../../packages/core-records/src/authority/delegations.ts';
import { bearer, call, createWorld, personPath, serverUrl } from '../acceptance/world.ts';
import { instantOf, waitPast } from '../support/lock-wait-race.ts';

let world: Awaited<ReturnType<typeof createWorld>>;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await createWorld('narrowedchild');
}, 120_000);
afterAll(async () => {
  await world?.close();
});

const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

it('a narrowed child is still found narrowed after its parent expires later in the same transaction', async () => {
  const made = await call(
    world.api,
    personPath('alpha', '/task/create'),
    { operationId: randomUUID(), fields: { title: 'A narrowed child report' } },
    bearer(world.ada.token),
  );
  expect(made.code).toBe('ok');
  const scope = { kind: 'record' as const, id: String(made.body['recordId']) };
  const keys = {
    ok: true as const,
    keys: credentialKeyring('proof', new Map([['proof', randomBytes(32)]])),
  };
  const helper = randomUUID();
  const minted = await world.db.app.withBusiness(world.alpha, async (tx) => {
    await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      tx.businessId,
      helper,
    ]);
    const runGrant = await issueGrant(tx, [], {
      subject: { kind: 'person', id: String(world.ada.personId) },
      collection: 'run',
      action: 'write',
      scope: { kind: 'business', id: null },
      parentGrantId: null,
      grantedByActorId: String(world.ada.actorId),
    });
    if (!runGrant.ok) throw new Error(`run grant refused: ${runGrant.refusal.code}`);
    const parent = await mintDelegation(
      tx,
      {
        agentActorId: String(world.agent.actorId),
        delegatePersonId: String(world.ada.personId),
        mintedByActorId: String(world.ada.actorId),
        purpose: `narrowed_parent_${randomUUID().slice(0, 8)}`,
        collections: ['task', 'run'],
        actions: ['read', 'write'],
        purposeScope: scope,
        expiresAt: new Date(Date.now() + 5000),
      },
      keys,
    );
    if (!parent.ok) throw new Error(`parent refused: ${parent.refusal.code}`);
    const child = await mintChildDelegation(
      tx,
      parent.value.delegation,
      {
        agentActorId: helper,
        purpose: `narrowed_child_${randomUUID().slice(0, 8)}`,
        collections: ['task'],
        actions: ['write'],
        expiresAt: parent.value.delegation.expiresAt,
      },
      keys,
    );
    if (!child.ok) throw new Error(`child refused: ${child.refusal.code}`);
    return { parent: parent.value.delegation, child: child.value };
  });
  // The delegate's task:write is cut, so the child now answers narrowed.
  await world.db.admin.execute(
    `update public.grants set revoked_at = greatest(now(), granted_at)
      where business_id = $1 and collection = 'task' and action = 'write'
        and revoked_at is null and subject_id = any($2::uuid[])`,
    [world.alpha, [world.ada.personId, world.ada.actorId]],
  );
  const deadline = await instantOf(
    world.db,
    'select expires_at::text as at from public.delegations where id = $1',
    [minted.parent.id],
  );
  const request = { collection: 'task', action: 'write', scope } as const;
  const found = await world.db.app.withBusiness(world.alpha, async (tx) => {
    const live = await resolveDelegation(tx, helper, minted.child.credential);
    if (!live.ok) throw new Error(`first resolve refused: ${live.refusal.code}`);
    const reach = await checkDelegatedAuthority(tx, live.value, request);
    expect(reach.ok ? 'ok' : reach.refusal.code, 'the first answer is narrowed').toBe(
      'DELEGATION_NARROWED',
    );
    await waitPast(world.db, deadline);
    return await resolveNarrowedDelegation(tx, helper, minted.child.credential, request);
  });
  expect(found?.id, 'the report still finds the child').toBe(minted.child.delegation.id);
}, 120_000);
