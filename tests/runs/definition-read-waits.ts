// SPDX-License-Identifier: AGPL-3.0-only
//
// #1904 P2's cases that wait: on the run, the reservation or the business
// lock, each held by a connection of its own, with the waiting call on the
// door's own. Run by
// `the-definition-read-and-its-replay-serve-only-the-leases-own-live-holder.test.ts`.

import { expect } from 'vitest';
import { revokeDelegation } from '../../packages/core-records/src/index.ts';
import type { Answer } from '../api/fixture.ts';
import { holdRows, racer } from '../runtime/schedules-harness.ts';
import { delegationOf, parkedUnlessAnswered, s, signedIn } from './run-stop-door-world.ts';
import {
  carriesNoText,
  ENTRY,
  eventsOf,
  freshFile,
  leaseEndsIn,
  ledgerOf,
  pinnedWork,
  read,
  readBody,
  textOf,
  wroteNothing,
} from './definition-world.ts';
import {
  codeOf,
  holdBusinessLock,
  holdReservation,
  pastTheExpiry,
  revoke,
  sentWhileHeld,
} from './definition-read-cases.ts';
import { detailOf } from './turn-world.ts';

export async function revokedWhileTheReadWaitsOnTheRun(): Promise<void> {
  const on = await pinnedWork('definition read f2');
  const as = await signedIn();
  // Mutation: skip `lockDelegation`'s live test -> served (or workJudged's code), red.
  const answer = await sentWhileHeld(
    async () => await holdRows(s, 'planned_runs', [on.runId]),
    async () => await read(on, readBody(on), as),
    'planned_runs',
    revoke(on),
  );
  expect(codeOf(answer), JSON.stringify(answer.body)).toBe('AUTHORITY_LOST');
  carriesNoText(answer);
  expect(await ledgerOf(on.runId)).toBe(0);
}

export async function aRevocationAfterTheDelegationLockWaits(): Promise<void> {
  const on = await pinnedWork('definition read f3');
  const as = await signedIn();
  const revoker = racer(s);
  let revoking: Promise<Date | null> | undefined;
  try {
    // Mutation: `lockDelegation` without its row lock -> the revocation commits first, the read refused, red.
    const answer = await sentWhileHeld(
      holdReservation(on),
      async () => await read(on, readBody(on), as),
      'reservations',
      async () => {
        revoking = revoker.withBusiness(
          s.business,
          async (tx) => await revokeDelegation(tx, delegationOf(on.work)),
        );
        expect(await parkedUnlessAnswered(revoking, 'delegations', 1), 'the revocation waits').toBe(
          true,
        );
      },
    );
    expect(detailOf(answer)['text'], JSON.stringify(answer.body)).toBe(textOf(ENTRY));
    expect(await revoking, 'the revocation committed after the read').not.toBeNull();
  } finally {
    await revoking?.catch(() => null);
    await revoker.close();
  }
}

export async function aReplayHeldAtTheReservationPastTheExpiry(): Promise<void> {
  const on = await pinnedWork('definition read g');
  const as = await signedIn();
  const body = readBody(on);
  expect(detailOf(await read(on, body, as))['text']).toBe(textOf(ENTRY));
  const replaying = async (): Promise<Answer> => {
    await leaseEndsIn(on.work, 3);
    return await read(on, body, as);
  };
  // Mutation: drop the final lease check -> served on the earlier live finding, red.
  const replay = await sentWhileHeld(holdReservation(on), replaying, 'reservations', async () => {
    await pastTheExpiry(on);
  });
  expect(codeOf(replay), JSON.stringify(replay.body)).toBe('LEASE_EXPIRED');
  carriesNoText(replay);
}

export async function aFirstReadHeldAtTheReservationPastTheExpiry(): Promise<void> {
  const path = freshFile('# Case h\n');
  const on = await pinnedWork('definition read h', [path]);
  const as = await signedIn();
  const body = readBody(on, path);
  const reading = async (): Promise<Answer> => {
    await leaseEndsIn(on.work, 3);
    return await read(on, body, as);
  };
  // Mutation: drop the final lease check -> served, a ledger row and an event, red.
  const answer = await sentWhileHeld(holdReservation(on), reading, 'reservations', async () => {
    await pastTheExpiry(on);
  });
  expect(codeOf(answer), JSON.stringify(answer.body)).toBe('LEASE_EXPIRED');
  carriesNoText(answer, path);
  await wroteNothing(on, path, body.operationId);
}

/** The file's one agent login, ended or given back by the owner connection. */
const login = (active: boolean) => async (): Promise<void> => {
  await s.db.admin.execute(
    `update public.actor_logins
        set active = $3::boolean, deactivated_at = case when $3::boolean then null else now() end
      where business_id = $1 and actor_id = $2`,
    [s.business, s.agentActorId, active],
  );
};

export async function aReplayWhoseLoginEndedWhileItWaited(): Promise<void> {
  const on = await pinnedWork('definition read i');
  const as = await signedIn();
  const body = readBody(on);
  expect(detailOf(await read(on, body, as))['text']).toBe(textOf(ENTRY));
  try {
    // Mutation: run the replay's work outside `workJudged` -> served, red.
    const replay = await sentWhileHeld(
      holdReservation(on),
      async () => await read(on, body, as),
      'reservations',
      login(false),
    );
    expect(codeOf(replay), JSON.stringify(replay.body)).toBe('AUTH_NO_AGENT_IDENTITY');
    carriesNoText(replay);
  } finally {
    await login(true)();
  }
}

export async function aFirstReadHeldOnTheBusinessLockPastTheExpiry(): Promise<void> {
  const path = freshFile('# Case j\n');
  const on = await pinnedWork('definition read j, first read', [path]);
  const as = await signedIn();
  const body = readBody(on, path);
  const reading = async (): Promise<Answer> => {
    await leaseEndsIn(on.work, 3);
    return await read(on, body, as);
  };
  // Mutation (D1904-1): the final lease check moved back before `agentStanding` -> served, red.
  // The read's own audit event takes this lock too, so its wait may land there instead.
  const answer = await sentWhileHeld(holdBusinessLock, reading, 'advisory', async () => {
    await pastTheExpiry(on);
  });
  expect(codeOf(answer), JSON.stringify(answer.body)).toBe('LEASE_EXPIRED');
  carriesNoText(answer, path);
  await wroteNothing(on, path, body.operationId);
}

export async function aReplayHeldOnTheBusinessLockPastTheExpiry(): Promise<void> {
  const on = await pinnedWork('definition read j, replay');
  const as = await signedIn();
  const body = readBody(on);
  expect(detailOf(await read(on, body, as))['text']).toBe(textOf(ENTRY));
  const replaying = async (): Promise<Answer> => {
    await leaseEndsIn(on.work, 3);
    return await read(on, body, as);
  };
  // Mutation (D1904-1): the replay's final lease check moved back before `agentStanding` -> served, red.
  const replay = await sentWhileHeld(holdBusinessLock, replaying, 'advisory', async () => {
    await pastTheExpiry(on);
  });
  expect(codeOf(replay), JSON.stringify(replay.body)).toBe('LEASE_EXPIRED');
  carriesNoText(replay);
  expect(await ledgerOf(on.runId), 'the first read only').toBe(1);
  expect(await eventsOf(body.operationId), 'the first read only').toBe(1);
}
