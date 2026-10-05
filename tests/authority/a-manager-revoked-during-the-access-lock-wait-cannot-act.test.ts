// SPDX-License-Identifier: AGPL-3.0-only
//
// Every change to who may do what waits for the business's access lock, and
// the caller's `access:manage` is first asked before that wait. A manager
// whose only grant is revoked while it waits holds nothing when the lock is
// theirs, so `access.end` and `access.revoke` are each refused
// SCOPE_NOT_GRANTED once the lock is taken, and write nothing.
//
// Ada, Noah and Mia each hold one independent root business-wide
// `access:manage`. A fixture transaction holds Noah's grant row; Ada's
// revocation of it takes the access lock and waits on that row; Noah's act is
// admitted on his still-live grant and waits on the access lock behind Ada.
// The fixture lets go, Ada's revocation commits, and only then does Noah's act
// get the lock.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandRequest } from '../../packages/core-commands/src/commands/requests.ts';
import { grantAccess } from '../../packages/core-records/src/authority/access.ts';
import { connect, type TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';

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

/** Waits until some other backend waits on a lock of this kind (`transactionid`, `advisory`). */
async function waitingOn(world: World, event: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const rows = await world.db.admin.execute<{ waiting: boolean }>(
      `select exists (select 1 from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and wait_event_type = 'Lock' and wait_event = $1) as waiting`,
      [event],
    );
    if (rows[0]?.waiting === true) return;
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await delay(10);
  }
  throw new Error(`nothing reached a ${event} lock wait`);
}

const noop = (): void => undefined;

function gate(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release: () => void = noop;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** A fixture transaction on its own connection, holding the grant row until it is let go. */
async function holdGrant(
  world: World,
  grantId: string,
): Promise<{ readonly letGo: () => Promise<void> }> {
  const db = connect(world.db.appUrl);
  const held = gate();
  const release = gate();
  const done = db.withBusiness(world.alpha, async (tx) => {
    await tx.query('select id from public.grants where business_id = $1 and id = $2 for update', [
      tx.businessId,
      grantId,
    ]);
    held.release();
    await release.promise;
  });
  await Promise.race([held.promise, done]);
  return {
    letGo: async () => {
      release.release();
      await done.finally(async () => await db.close());
    },
  };
}

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
    const blocker = await holdGrant(world, noahGrant);
    let revoking: ReturnType<typeof executeCommand> | undefined;
    let acting: ReturnType<typeof executeCommand> | undefined;
    try {
      revoking = executeCommand(adaDb, world.alpha, world.ada.presented, 'api', {
        command: 'access.revoke',
        operationId: randomUUID(),
        grantId: noahGrant,
      });
      await waitingOn(world, 'transactionid');
      acting = executeCommand(noahDb, world.alpha, world.noah.presented, 'api', act());
      await waitingOn(world, 'advisory');
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

it('ending a person by a manager revoked during the access lock wait is refused, and ends nothing', async () => {
  const world = await createWorld('accesslockend');
  try {
    const raced = await raceNoah(world, () => ({
      command: 'access.end',
      operationId: randomUUID(),
      holderId: String(world.mia.personId),
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

it('revoking a grant by a manager revoked during the access lock wait is refused, and revokes nothing', async () => {
  const world = await createWorld('accesslockrevoke');
  try {
    const miaGrant = await manager(world, world.mia.personId);
    const raced = await raceNoah(world, () => ({
      command: 'access.revoke',
      operationId: randomUUID(),
      grantId: miaGrant,
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
