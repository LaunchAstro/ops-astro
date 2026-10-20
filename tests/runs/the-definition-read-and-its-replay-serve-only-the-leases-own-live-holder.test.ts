// SPDX-License-Identifier: AGPL-3.0-only
//
// #1904 P2 (design v3, "Guards in order" R1 to R7, and director D1904-1):
// `definition.read` and its replay hand a pinned file's text only to the
// lease's own holder, under the delegation the lease was minted with, at the
// lease's fence, with the lease live when the answer is decided. Through the
// real agent door. Each schedule that waits does so on a connection of its
// own, held by another connection of its own (`holdRows`, `independently`).
//
// Refused, each with no text in the body: run 1's lease under run 2's
// delegation (a), a stale fence (b), an ended lease (c), an undeclared
// `runId` (d), a replay after the lease ended (e), a delegation revoked
// before the read (f1) or while it waits on the run (f2), a replay (g) and a
// first read (h) held at the reservation past the lease's expiry, a replay
// whose login ended while it waited (i), and a first read and a replay held
// on the business lock in the door's final standing past the lease's expiry
// (j, D1904-1). A revocation sent once the read holds the delegation waits
// for the read, which is served (f3). Control: the same lease reads, and its
// replay answers the same bytes with no second ledger row or event.

import { describe, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import {
  anEndedLease,
  anotherRunsLeaseUnderThisDelegation,
  anUndeclaredRunId,
  aReplayAfterTheLeaseEnded,
  aStaleFence,
  revokedBeforeTheRead,
  servedAndReplayed,
} from './definition-read-cases.ts';
import {
  aFirstReadHeldAtTheReservationPastTheExpiry,
  aFirstReadHeldOnTheBusinessLockPastTheExpiry,
  aReplayHeldAtTheReservationPastTheExpiry,
  aReplayHeldOnTheBusinessLockPastTheExpiry,
  aReplayWhoseLoginEndedWhileItWaited,
  aRevocationAfterTheDelegationLockWaits,
  revokedWhileTheReadWaitsOnTheRun,
} from './definition-read-waits.ts';
import { useDefinitionWorld } from './definition-world.ts';

const CASES: readonly (readonly [string, () => Promise<void>])[] = [
  [
    'control: the lease holder reads the file, and its replay answers the same bytes with no second row or event',
    servedAndReplayed,
  ],
  [
    "a: run 1's lease under run 2's delegation is refused LEASE_NOT_OWNED",
    anotherRunsLeaseUnderThisDelegation,
  ],
  ['b: a stale fence is refused LEASE_NOT_OWNED', aStaleFence],
  ['c: an ended lease is refused LEASE_EXPIRED', anEndedLease],
  ['d: an undeclared runId is refused COMMAND_BODY_INVALID', anUndeclaredRunId],
  ['e: a replay after the lease ended is refused LEASE_EXPIRED', aReplayAfterTheLeaseEnded],
  ['f1: a delegation revoked before the read is refused DELEGATION_NOT_LIVE', revokedBeforeTheRead],
  [
    'f2: a delegation revoked while the read waits on the run is refused AUTHORITY_LOST',
    revokedWhileTheReadWaitsOnTheRun,
  ],
  [
    'f3: a revocation sent once the read holds the delegation waits, and the read is served',
    aRevocationAfterTheDelegationLockWaits,
  ],
  [
    'g: a replay held at the reservation past the lease expiry is refused LEASE_EXPIRED',
    aReplayHeldAtTheReservationPastTheExpiry,
  ],
  [
    'h: a first read held at the reservation past the lease expiry is refused LEASE_EXPIRED and writes nothing',
    aFirstReadHeldAtTheReservationPastTheExpiry,
  ],
  [
    'j: a first read held on the business lock past the lease expiry is refused LEASE_EXPIRED and writes nothing',
    aFirstReadHeldOnTheBusinessLockPastTheExpiry,
  ],
  [
    'j: a replay held on the business lock past the lease expiry is refused LEASE_EXPIRED',
    aReplayHeldOnTheBusinessLockPastTheExpiry,
  ],
  // Last: it ends the file's one agent login for a moment, and gives it back.
  [
    'i: a replay whose login ended while it waited is refused AUTH_NO_AGENT_IDENTITY',
    aReplayWhoseLoginEndedWhileItWaited,
  ],
];

describe.skipIf(serverUrl === undefined)('the definition read and its replay', () => {
  useDefinitionWorld('defread');

  it.each(CASES)('%s', async (_name, run) => await run(), 60_000);
});
