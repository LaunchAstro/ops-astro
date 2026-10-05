// SPDX-License-Identifier: AGPL-3.0-only
//
// The last-manager guard counts only managers who stay effective after the
// act. A grant cut from the one being revoked, or from a grant held by the
// person whose access ends, stops being effective with it, so it is no
// surviving manager: `access.revoke` of its parent and `access.end` of its
// granter are both refused ACCESS_LAST_MANAGER and change nothing.
//
// Ada is alpha's owner and holds every key; Noah holds a membership and no
// grants until a case cuts him one from Ada's.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { otherManagers } from '../../packages/core-records/src/authority/access.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { bearer, call, createWorld, personPath, serverUrl } from '../acceptance/world.ts';

const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

it('revoking a parent access grant cannot remove every manager', async () => {
  const world = await createWorld('solow020manager');
  try {
    const rootId = await world.db.app.withBusiness(world.alpha, async (tx) => {
      const [root] = await tx.query<{ id: string }>(
        `select id from public.grants where subject_kind = 'person' and subject_id = $1
           and collection = 'access' and action = 'manage' and scope_kind = 'business'
           and revoked_at is null`,
        [world.ada.personId],
      );
      if (root === undefined) throw new Error('missing control grant');
      await tx.query('update public.grants set can_delegate = true where id = $1', [root.id]);
      const child = await issueGrant(tx, [{ kind: 'person', id: String(world.ada.personId) }], {
        subject: { kind: 'person', id: String(world.noah.personId) },
        scope: { kind: 'business', id: null },
        collection: 'access',
        action: 'manage',
        parentGrantId: root.id,
        grantedByActorId: String(world.ada.actorId),
      });
      expect(child.ok).toBe(true);
      expect(await otherManagers(tx, [])).toBe(2);
      return root.id;
    });
    const answer = await call(
      world.api,
      personPath('alpha', '/access/revoke'),
      { operationId: randomUUID(), grantId: rootId },
      bearer(world.ada.token),
    );
    const remaining = await world.db.app.withBusiness(world.alpha, (tx) => otherManagers(tx, []));
    expect({ code: answer.code, remaining }).toEqual({ code: 'ACCESS_LAST_MANAGER', remaining: 2 });
  } finally {
    await world.close();
  }
});

/** Every grant and membership of the business, so a refusal can be shown to write nothing. */
const stateOf = async (tx: TenantQuery): Promise<unknown> => ({
  grants: await tx.query(
    `select id, revoked_at from public.grants where business_id = $1 order by id`,
    [tx.businessId],
  ),
  memberships: await tx.query(
    `select person_id, active from public.memberships where business_id = $1 order by person_id`,
    [tx.businessId],
  ),
});

it('ending the person whose grant is the parent of the only other manager is refused, and changes nothing', async () => {
  const world = await createWorld('lastmanagerend');
  try {
    const before = await world.db.app.withBusiness(world.alpha, async (tx) => {
      const [root] = await tx.query<{ id: string }>(
        `select id from public.grants where subject_kind = 'person' and subject_id = $1
           and collection = 'access' and action = 'manage' and scope_kind = 'business'
           and revoked_at is null`,
        [world.ada.personId],
      );
      if (root === undefined) throw new Error('missing control grant');
      await tx.query('update public.grants set can_delegate = true where id = $1', [root.id]);
      const child = await issueGrant(tx, [{ kind: 'person', id: String(world.ada.personId) }], {
        subject: { kind: 'person', id: String(world.noah.personId) },
        scope: { kind: 'business', id: null },
        collection: 'access',
        action: 'manage',
        parentGrantId: root.id,
        grantedByActorId: String(world.ada.actorId),
      });
      expect(child.ok).toBe(true);
      expect(await otherManagers(tx, [])).toBe(2);
      return await stateOf(tx);
    });
    const answer = await call(
      world.api,
      personPath('alpha', '/access/end'),
      { operationId: randomUUID(), holderId: world.ada.personId },
      bearer(world.ada.token),
    );
    const after = await world.db.app.withBusiness(world.alpha, stateOf);
    expect({ code: answer.code, after }).toEqual({ code: 'ACCESS_LAST_MANAGER', after: before });
  } finally {
    await world.close();
  }
});

/** The person's business-wide access grant, made able to delegate and to let its children delegate. */
const delegatingRoot = async (tx: TenantQuery, personId: unknown): Promise<{ id: string }> => {
  const [root] = await tx.query<{ id: string }>(
    `select id from public.grants where subject_kind = 'person' and subject_id = $1
       and collection = 'access' and action = 'manage' and scope_kind = 'business'
       and revoked_at is null`,
    [personId],
  );
  if (root === undefined) throw new Error('missing control grant');
  await tx.query(
    'update public.grants set can_delegate = true, may_permit_delegation = true where id = $1',
    [root.id],
  );
  return root;
};

it('revoking a root access grant is refused when every other manager sits two grants below it', async () => {
  const world = await createWorld('lastmanagerchain');
  try {
    const rootId = await world.db.app.withBusiness(world.alpha, async (tx) => {
      const root = await delegatingRoot(tx, world.ada.personId);
      const access = { scope: { kind: 'business', id: null }, collection: 'access' } as const;
      const child = await issueGrant(tx, [{ kind: 'person', id: String(world.ada.personId) }], {
        ...access,
        subject: { kind: 'person', id: String(world.noah.personId) },
        action: 'manage',
        canDelegate: true,
        parentGrantId: root.id,
        grantedByActorId: String(world.ada.actorId),
      });
      if (!child.ok) throw new Error(`child grant refused: ${JSON.stringify(child)}`);
      const grandchild = await issueGrant(
        tx,
        [{ kind: 'person', id: String(world.noah.personId) }],
        {
          ...access,
          subject: { kind: 'person', id: String(world.mia.personId) },
          action: 'manage',
          parentGrantId: child.value,
          grantedByActorId: String(world.noah.actorId),
        },
      );
      expect(grandchild.ok).toBe(true);
      expect(await otherManagers(tx, [])).toBe(3);
      return root.id;
    });
    const answer = await call(
      world.api,
      personPath('alpha', '/access/revoke'),
      { operationId: randomUUID(), grantId: rootId },
      bearer(world.ada.token),
    );
    const remaining = await world.db.app.withBusiness(world.alpha, (tx) => otherManagers(tx, []));
    expect({ code: answer.code, remaining }).toEqual({ code: 'ACCESS_LAST_MANAGER', remaining: 3 });
  } finally {
    await world.close();
  }
});
