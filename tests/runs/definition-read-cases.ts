// SPDX-License-Identifier: AGPL-3.0-only
//
// #1904 P2's guards that answer without a wait, and what its waiting cases
// share (`definition-read-waits.ts`). Run by
// `the-definition-read-and-its-replay-serve-only-the-leases-own-live-holder.test.ts`.

import { expect } from 'vitest';
import { advisoryLock, revokeDelegation } from '../../packages/core-records/src/index.ts';
import type { Answer } from '../api/fixture.ts';
import { holdRows, startedBefore, waitPast, type Holder } from '../runtime/schedules-harness.ts';
import {
  asAgent,
  delegationOf,
  independently,
  leaseOf,
  parkedUnlessAnswered,
  s,
  signedIn,
} from './run-stop-door-world.ts';
import {
  bytesOf,
  carriesNoText,
  digestOf,
  ENTRY,
  eventsOf,
  LEASE_EXPIRY,
  leaseEndsIn,
  ledgerOf,
  pinnedWork,
  read,
  readBody,
  textOf,
  type Pinned,
} from './definition-world.ts';
import { detailOf } from './turn-world.ts';

export const codeOf = (answer: Answer): unknown => answer.body['code'];

export const reservationOf = (on: Pinned): string => String(on.work.decision['reservationId']);

/**
 * Send while `hold` is held: the call is seen parked on `table`, `during`
 * runs, then the hold lets go. The call's answer.
 */
export async function sentWhileHeld(
  hold: () => Promise<Holder>,
  send: () => Promise<Answer>,
  table: string,
  during: () => Promise<void>,
): Promise<Answer> {
  const holder = await hold();
  let answering: Promise<Answer> | undefined;
  try {
    answering = send();
    expect(await parkedUnlessAnswered(answering, table, 1), `parked on ${table}`).toBe(true);
    await during();
  } finally {
    await holder.release();
  }
  return await answering;
}

/** Past the lease's expiry on the database clock, the waiting transaction begun before it. */
export async function pastTheExpiry(on: Pinned): Promise<void> {
  expect(await startedBefore(s, LEASE_EXPIRY, leaseOf(on.work)), 'began before the expiry').toBe(
    true,
  );
  await waitPast(s, LEASE_EXPIRY, leaseOf(on.work));
}

/** The reservation row, held `for update` on a connection of its own. */
export const holdReservation =
  (on: Pinned): (() => Promise<Holder>) =>
  async () =>
    await holdRows(s, 'reservations', [reservationOf(on)]);

/** The business lock `agentStanding` takes last (`agent-standing.ts`), held on its own connection. */
export const holdBusinessLock = async (): Promise<Holder> =>
  await independently(async (tx) => {
    await advisoryLock(tx, tx.businessId.toLowerCase());
  });

export async function servedAndReplayed(): Promise<void> {
  const on = await pinnedWork('definition read control');
  const as = await signedIn();
  const body = readBody(on);
  const bytes = bytesOf(ENTRY);
  const identity = { path: ENTRY, digest: digestOf(bytes), size: bytes.byteLength, sequence: 1 };
  const first = await read(on, body, as);
  expect(detailOf(first), JSON.stringify(first.body)).toMatchObject(identity);
  expect(Buffer.from(String(detailOf(first)['text']), 'utf8').equals(Buffer.from(bytes))).toBe(
    true,
  );
  // Mutation: the replay answers the stored row (releaseReplay undefined) -> no text, red.
  const again = await read(on, body, as);
  expect(detailOf(again), JSON.stringify(again.body)).toMatchObject(identity);
  expect(detailOf(again)['text']).toBe(textOf(ENTRY));
  expect(await ledgerOf(on.runId), 'no second ledger row').toBe(1);
  expect(await eventsOf(body.operationId), 'no second event').toBe(1);
}

export async function anotherRunsLeaseUnderThisDelegation(): Promise<void> {
  const on = await pinnedWork('definition read a, run 1');
  const mine = await pinnedWork('definition read a, run 2');
  // Run 1's lease, presented under run 2's delegation, by the same agent.
  // Mutation: `holdsWork` true on the actor alone -> served, red.
  const answer = await asAgent('/definition/read', mine.work, readBody(on), await signedIn());
  expect(codeOf(answer), JSON.stringify(answer.body)).toBe('LEASE_NOT_OWNED');
  carriesNoText(answer);
  expect(await ledgerOf(on.runId)).toBe(0);
}

export async function aStaleFence(): Promise<void> {
  const on = await pinnedWork('definition read b');
  const body = readBody(on);
  await s.db.admin.execute(
    'update public.leases set fence = fence + 1 where business_id = $1 and id = $2',
    [s.business, leaseOf(on.work)],
  );
  // Mutation: drop the fence comparison in `lockLease` -> served, red.
  const answer = await read(on, body, await signedIn());
  expect(codeOf(answer), JSON.stringify(answer.body)).toBe('LEASE_NOT_OWNED');
  carriesNoText(answer);
  expect(await ledgerOf(on.runId)).toBe(0);
}

export async function anEndedLease(): Promise<void> {
  const on = await pinnedWork('definition read c');
  await leaseEndsIn(on.work, 1);
  await waitPast(s, LEASE_EXPIRY, leaseOf(on.work));
  // Mutation: drop `lockLease`'s live check -> readPinned's LEASE_NOT_OWNED, red.
  const answer = await read(on, readBody(on), await signedIn());
  expect(codeOf(answer), JSON.stringify(answer.body)).toBe('LEASE_EXPIRED');
  carriesNoText(answer);
  expect(await ledgerOf(on.runId)).toBe(0);
}

export async function anUndeclaredRunId(): Promise<void> {
  const on = await pinnedWork('definition read d');
  // Mutation: accept extra operand keys -> served, red.
  const answer = await read(on, readBody(on, ENTRY, { runId: on.runId }), await signedIn());
  expect(codeOf(answer), JSON.stringify(answer.body)).toBe('COMMAND_BODY_INVALID');
  carriesNoText(answer);
  expect(await ledgerOf(on.runId)).toBe(0);
}

export async function aReplayAfterTheLeaseEnded(): Promise<void> {
  const on = await pinnedWork('definition read e');
  const as = await signedIn();
  const body = readBody(on);
  expect(detailOf(await read(on, body, as))['text']).toBe(textOf(ENTRY));
  await leaseEndsIn(on.work, 1);
  await waitPast(s, LEASE_EXPIRY, leaseOf(on.work));
  // Mutation: the replay answers the stored metadata and a fresh source read without `lockFacts` -> served, red.
  const replay = await read(on, body, as);
  expect(codeOf(replay), JSON.stringify(replay.body)).toBe('LEASE_EXPIRED');
  carriesNoText(replay);
}

/** The work's delegation revoked on a connection of its own, and committed. */
export const revoke =
  (on: Pinned): (() => Promise<void>) =>
  async (): Promise<void> => {
    const ending = await independently(
      async (tx) => await revokeDelegation(tx, delegationOf(on.work)),
    );
    await ending.release();
  };

export async function revokedBeforeTheRead(): Promise<void> {
  const on = await pinnedWork('definition read f1');
  await revoke(on)();
  // Mutation: skip `resolveDelegation`'s live test in `authorise` -> lockDelegation's AUTHORITY_LOST, red.
  const answer = await read(on, readBody(on), await signedIn());
  expect(codeOf(answer), JSON.stringify(answer.body)).toBe('DELEGATION_NOT_LIVE');
  carriesNoText(answer);
  expect(await ledgerOf(on.runId)).toBe(0);
}
