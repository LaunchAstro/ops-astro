// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-11: one sub-delegation, depth one, strictly narrower than its parent.
// The subset is held by the database role, not by the code that mints it
// (`the_child_is_a_strict_subset` writes straight through the application
// role); the operation set is fixed at mint; and every call a child makes
// re-reads its parent in the serving transaction, so the parent's expiry,
// revocation or narrowing bites at the child's next call (the U6 fallback:
// token claims add nothing).

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import {
  checkDelegatedAuthority,
  revokeDelegation,
} from '../../packages/core-records/src/authority/delegations.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import {
  asAgent,
  awaitParked,
  barrier,
  handbackBody,
  racer,
  rows,
  type Schedules,
} from './schedules-harness.ts';
import {
  callCode,
  child,
  childRequest,
  insertRaw,
  mintChild,
  mintedCode,
  noDatabase,
  parentWork,
  readAsHelper,
  updateRaw,
  useChildWorld,
  w,
} from './aw-11-child-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useChildWorld('aw11');

const REFUSED = /delegations: /u;

const liveChildren = async (on: Schedules, parentId: string) =>
  (
    await rows<{ readonly n: string }>(
      on,
      `select count(*)::text as n from public.delegations
        where business_id = $1 and parent_delegation_id = $2`,
      [on.business, parentId],
    )
  )[0]?.n;

it('the_child_is_a_strict_subset: the application role admits only a strictly narrower child of a live parent, depth one', async () => {
  const { parent } = await parentWork(w.s);
  expect(parent.collections.toSorted()).toStrictEqual(['run', 'task']);
  const raw = async (overrides: Readonly<Record<string, unknown>>, parentId?: string) =>
    await insertRaw(w.s, parentId ?? parent.id, w.helper, overrides);

  // Equal to the parent, wider by an action, wider by a collection, and a
  // widening hidden in a narrower set: each refused at the role.
  expect(await raw({ collections: parent.collections, actions: parent.actions })).toMatch(REFUSED);
  expect(await raw({ collections: ['task'], actions: ['read', 'assign'] })).toMatch(REFUSED);
  expect(await raw({ collections: ['task', 'invoice'], actions: ['read'] })).toMatch(REFUSED);
  expect(await raw({ collections: ['invoice'], actions: ['read'] })).toMatch(REFUSED);
  // Another person's authority, another task, another authoriser: refused.
  expect(await raw({ delegate_person_id: w.bravo.decider.personId })).not.toBe('inserted');
  expect(await raw({ purpose_scope_id: randomUUID() })).toMatch(REFUSED);
  expect(
    await raw({ minted_by_actor_id: w.s.decider.actorId, delegate_person_id: randomUUID() }),
  ).not.toBe('inserted');

  // Strictly narrower: admitted.
  expect(await raw({ collections: ['task'], actions: ['read'] })).toBe('inserted');
  expect(await raw({ collections: ['task', 'run'], actions: ['read', 'write'] })).toBe('inserted');

  // Depth one: a child of a child is refused, whatever it asks for.
  const [first] = await rows<{ readonly id: string }>(
    w.s,
    `select id from public.delegations where business_id = $1 and parent_delegation_id = $2
      order by granted_at limit 1`,
    [w.s.business, parent.id],
  );
  expect(await raw({ collections: ['task'], actions: ['read'] }, String(first?.id))).toMatch(
    REFUSED,
  );

  // A parent that is no longer live admits no child.
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await revokeDelegation(tx, parent.id);
  });
  expect(await raw({ collections: ['task'], actions: ['read'] })).toMatch(REFUSED);
  expect(await liveChildren(w.s, parent.id)).toBe('2');
});

it('the_child_is_a_strict_subset: the mint refuses a child that is not strictly narrower, and the child cannot reach what it was not given', async () => {
  const { parent, work } = await parentWork(w.s);
  const minted = async (overrides: Parameters<typeof childRequest>[1]) =>
    mintedCode(await mintChild(w.s, parent, childRequest(w.helper, overrides)));

  expect(await minted({ collections: parent.collections, actions: parent.actions })).toBe(
    'DELEGATION_WIDENS',
  );
  expect(await minted({ collections: ['task'], actions: ['read', 'assign'] })).toBe(
    'DELEGATION_WIDENS',
  );
  expect(await minted({ collections: ['invoice'], actions: ['read'] })).toBe('DELEGATION_WIDENS');
  expect(await minted({ actions: ['read', 'decide'] })).toBe('DELEGATION_EXCLUDES_DECISION');
  expect(await liveChildren(w.s, parent.id)).toBe('0');

  const narrow = await child(w.s, parent, w.helper);
  expect(narrow.delegation.parentDelegationId).toBe(parent.id);
  expect(narrow.delegation.purposeScope).toStrictEqual(parent.purposeScope);
  expect(narrow.delegation.delegatePersonId).toBe(parent.delegatePersonId);
  // The child reads its task; it cannot write it, though its parent could.
  expect(callCode(await readAsHelper(w.s, w.helper, narrow.credential, work.taskId))).toBe(
    'applied',
  );
  const write = await w.s.db.app.withBusiness(
    w.s.business,
    async (tx) =>
      await checkDelegatedAuthority(tx, narrow.delegation, {
        collection: 'task',
        action: 'write',
        scope: parent.purposeScope,
      }),
  );
  expect(write.ok ? 'reached' : write.refusal.code).toBe('DELEGATION_OUT_OF_PURPOSE');

  // Depth one through the code, and `run:write` inside the parent's
  // delegation is what creating a child takes.
  expect(mintedCode(await mintChild(w.s, narrow.delegation, childRequest(w.helper)))).toBe(
    'DELEGATION_WIDENS',
  );
  expect(mintedCode(await mintChild(w.s, w.taskOnly, childRequest(w.helper)))).toBe(
    'DELEGATION_OUT_OF_PURPOSE',
  );
});

it('AW-11 set frozen at mint: no update changes a delegation’s operation set, scope, person or parent', async () => {
  const { parent } = await parentWork(w.s);
  const narrow = await child(w.s, parent, w.helper);
  const id = narrow.delegation.id;
  const otherPerson = randomUUID();
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await tx.query(
      `insert into public.people (business_id, id, display_name) values ($1, $2, 'Other')`,
      [w.s.business, otherPerson],
    );
  });
  for (const [assignment, parameters] of [
    [`actions = array['read', 'write']`, []],
    [`collections = array['task', 'run']`, []],
    ['purpose_scope_id = $3', [randomUUID()]],
    ['delegate_person_id = $3', [otherPerson]],
    ['parent_delegation_id = null', []],
    [`purpose = 'widened'`, []],
  ] as const) {
    // Sequential: each assignment is its own refused statement.
    // oxlint-disable-next-line no-await-in-loop
    expect(await updateRaw(w.s, id, assignment, parameters), assignment).toMatch(REFUSED);
  }
  // The parent's set is frozen too: widening a parent would widen the ceiling
  // its children were checked against.
  expect(await updateRaw(w.s, parent.id, `actions = array['read']`)).toMatch(REFUSED);
  expect(await updateRaw(w.s, parent.id, `collections = array['task']`)).toMatch(REFUSED);
  // The lifecycle columns still move: the lease's heartbeat and revocation.
  expect(await updateRaw(w.s, id, `expires_at = now() + interval '2 hours'`)).toBe('updated');
  expect(
    await updateRaw(w.s, id, `revoked_at = now(), revocation_cause = 'delegation_revoked'`),
  ).toBe('updated');
});

it('AW-11 parent walk: each child call re-reads its parent; narrowed, expired and settled parents refuse at the next call', async () => {
  // Narrowed: the delegating person loses the grant the parent draws on.
  const narrowed = await parentWork(w.s);
  const a = await child(w.s, narrowed.parent, w.helper);
  expect(callCode(await readAsHelper(w.s, w.helper, a.credential, narrowed.work.taskId))).toBe(
    'applied',
  );
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await tx.query(
      `update public.delegations set revoked_at = now(), revocation_cause = 'authority_lost'
        where business_id = $1 and id = $2`,
      [w.s.business, narrowed.parent.id],
    );
  });
  expect(callCode(await readAsHelper(w.s, w.helper, a.credential, narrowed.work.taskId))).toBe(
    'DELEGATION_NARROWED',
  );

  // Expired: the parent's lease ran out; the child's own expiry is later.
  const expired = await parentWork(w.s);
  const b = await child(w.s, expired.parent, w.helper);
  expect(await updateRaw(w.s, expired.parent.id, 'expires_at = now()')).toBe('updated');
  expect(callCode(await readAsHelper(w.s, w.helper, b.credential, expired.work.taskId))).toBe(
    'DELEGATION_EXPIRED',
  );

  // Settled: the parent handed its work back; the child stops with it.
  const settled = await parentWork(w.s);
  const c = await child(w.s, settled.parent, w.helper);
  const handedBack = await asAgent(w.s, handbackBody(settled.work.picked), settled.credential);
  expect(callCode(handedBack)).toBe('applied');
  expect(callCode(await readAsHelper(w.s, w.helper, c.credential, settled.work.taskId))).toBe(
    'DELEGATION_REVOKED',
  );
});

it('AW-11 parent walk: the person’s live grants are read through the parent on every call', async () => {
  const { parent, work } = await parentWork(w.s);
  const narrow = await child(w.s, parent, w.helper);
  const [grant] = await rows<{ readonly id: string }>(
    w.s,
    `select id from public.grants where business_id = $1 and subject_id = $2
        and collection = 'task' and action = 'read' and revoked_at is null`,
    [w.s.business, w.s.decider.personId],
  );
  expect(callCode(await readAsHelper(w.s, w.helper, narrow.credential, work.taskId))).toBe(
    'applied',
  );
  // Revoked inside a transaction that then rolls back: the next call inside
  // it is narrowed, and nothing else changes.
  const code = await w.s.db.app
    .withBusiness(w.s.business, async (tx) => {
      await revokeGrant(tx, String(grant?.id));
      const reach = await checkDelegatedAuthority(tx, narrow.delegation, {
        collection: 'task',
        action: 'read',
        scope: parent.purposeScope,
      });
      throw new Error(reach.ok ? 'reached' : reach.refusal.code);
    })
    .catch((cause: unknown) => (cause instanceof Error ? cause.message : String(cause)));
  expect(code).toBe('DELEGATION_NARROWED');
});

it('AW-11 revoked: revoking the parent bites at the child’s next call, named DELEGATION_REVOKED; the child’s own revocation is DELEGATION_NOT_LIVE', async () => {
  const { parent, work } = await parentWork(w.s);
  const narrow = await child(w.s, parent, w.helper);
  expect(callCode(await readAsHelper(w.s, w.helper, narrow.credential, work.taskId))).toBe(
    'applied',
  );
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await revokeDelegation(tx, parent.id);
  });
  const refused = await readAsHelper(w.s, w.helper, narrow.credential, work.taskId);
  expect(callCode(refused)).toBe('DELEGATION_REVOKED');
  expect(JSON.stringify(refused)).not.toContain(narrow.credential);

  const other = await parentWork(w.s);
  const own = await child(w.s, other.parent, w.helper);
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await revokeDelegation(tx, own.delegation.id);
  });
  expect(callCode(await readAsHelper(w.s, w.helper, own.credential, other.work.taskId))).toBe(
    'DELEGATION_NOT_LIVE',
  );
});

it('AW-11 revoked: a parent revoked while a child is being minted admits no child (rechecked under the parent’s lock)', async () => {
  const { parent } = await parentWork(w.s);
  const revoker = racer(w.s);
  const [locked, gate] = [barrier(), barrier()];
  const revoking = revoker.withBusiness(w.s.business, async (tx) => {
    await revokeDelegation(tx, parent.id);
    locked.release();
    await gate.held;
  });
  await locked.held;
  const minting = mintChild(w.s, parent, childRequest(w.helper));
  await awaitParked(w.s, 'delegations', 1);
  gate.release();
  await revoking;
  await revoker.close();
  expect(mintedCode(await minting)).toBe('DELEGATION_REVOKED');
  expect(await liveChildren(w.s, parent.id)).toBe('0');
});
