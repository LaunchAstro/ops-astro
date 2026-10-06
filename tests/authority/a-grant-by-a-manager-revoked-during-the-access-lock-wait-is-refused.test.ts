// SPDX-License-Identifier: AGPL-3.0-only
//
// `access.grant` is admitted on the caller's `access:manage`, then waits for
// the business's access lock. A manager whose only grant is revoked while it
// waits holds nothing when the lock is theirs, so the grant is refused
// SCOPE_NOT_GRANTED once the lock is taken, and gives nothing.
//
// Ada, Noah and Mia each hold one independent root business-wide
// `access:manage`. A fixture transaction holds Noah's grant row; Ada's
// revocation of it takes the access lock and waits on that row; Noah's grant
// to Mia is admitted on his still-live grant and waits on the access lock
// behind Ada. The fixture lets go, Ada's revocation commits, and only then
// does Noah's grant get the lock. (The same harness as PR #954's
// access.end / access.revoke race test.)

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandRequest } from '../../packages/core-commands/src/commands/requests.ts';
import { grantAccess } from '../../packages/core-records/src/authority/access.ts';
import { connect, type TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';

const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

/** A root business-wide `access:manage` for the person, given by Ada. */
const manager = async (world: World, personId: unknown): Promise<string> =>
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    const given = await grantAccess(
      tx,
      { personId: String(personId), collection: 'access', action: 'manage', clientId: null },
      String(world.ada.actorId),
    );
    if (!given.ok) throw new Error(`grant refused: ${JSON.stringify(given)}`);
    return given.value;
  });

interface State {
  readonly grants: readonly { readonly id: string; readonly revoked: boolean }[];
  readonly memberships: readonly unknown[];
  readonly actors: readonly unknown[];
  readonly endings: readonly unknown[];
}

/** Every grant, membership, acting identity and access ending of the business. */
const stateOf = async (tx: TenantQuery): Promise<State> => ({
  grants: await tx.query<{ id: string; revoked: boolean }>(
    `select id, revoked_at is not null as revoked from public.grants
      where business_id = $1 order by id`,
    [tx.businessId],
  ),
  memberships: await tx.query(
    `select person_id, active from public.memberships where business_id = $1 order by person_id`,
    [tx.businessId],
  ),
  actors: await tx.query(
    `select id, active from public.actors where business_id = $1 order by id`,
    [tx.businessId],
  ),
  endings: await tx.query(
    `select id from public.access_endings where business_id = $1 order by id`,
    [tx.businessId],
  ),
});

/** The state with that one grant revoked: what Ada's revocation alone leaves. */
const revokedIn = (state: State, grantId: string): State => ({
  ...state,
  grants: state.grants.map((grant) => (grant.id === grantId ? { ...grant, revoked: true } : grant)),
});

/**
 * Noah's act, admitted while his grant is live and waiting on the access lock
 * behind Ada's revocation of that grant: what he is answered, what Ada's
 * revocation alone would leave, and what the race left.
 */
async function raceNoah(
  world: World,
  act: () => CommandRequest,
): Promise<{
  readonly code: string | undefined;
  readonly expected: State;
  readonly after: State;
}> {
  const noahGrant = await manager(world, world.noah.personId);
  await manager(world, world.mia.personId);
  const before = await world.db.app.withBusiness(world.alpha, stateOf);
  const adaDb = connect(world.db.appUrl);
  const noahDb = connect(world.db.appUrl);
  try {
    const blocker = await hold(world.db.appUrl, world.alpha, async (tx) => {
      await tx.query('select id from public.grants where business_id = $1 and id = $2 for update', [
        tx.businessId,
        noahGrant,
      ]);
    });
    let revoking: ReturnType<typeof executeCommand> | undefined;
    let acting: ReturnType<typeof executeCommand> | undefined;
    try {
      revoking = executeCommand(adaDb, world.alpha, world.ada.presented, 'api', {
        command: 'access.revoke',
        operationId: randomUUID(),
        grantId: noahGrant,
      });
      await waitingOn(world.db.admin, 'transactionid', 'from public.grants');
      acting = executeCommand(noahDb, world.alpha, world.noah.presented, 'api', act());
      await waitingOn(world.db.admin, 'advisory', 'pg_advisory_xact_lock');
    } finally {
      await blocker.letGo();
    }
    expect(isCommandRefusal(await revoking)).toBe(false);
    const answer = await acting;
    return {
      code: isCommandRefusal(answer) ? answer.code : undefined,
      expected: revokedIn(before, noahGrant),
      after: await world.db.app.withBusiness(world.alpha, stateOf),
    };
  } finally {
    await Promise.all([adaDb.close(), noahDb.close()]);
  }
}

it('giving a grant by a manager revoked during the access lock wait is refused, and gives nothing', async () => {
  const world = await createWorld('accesslockgrant');
  try {
    const raced = await raceNoah(world, () => ({
      command: 'access.grant',
      operationId: randomUUID(),
      holderId: String(world.mia.personId),
      collection: 'task',
      action: 'write',
    }));
    expect(raced).toEqual({
      code: 'SCOPE_NOT_GRANTED',
      expected: raced.expected,
      after: raced.expected,
    });
  } finally {
    await world.close();
  }
});
