// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-02 lease race (S-AW02-1): the pinned read takes the caller's lease row
// under the runtime's lock order before it records anything. A lease released
// by another transaction while the read waits is read as it stands once that
// transaction commits: the read is refused, no ledger row, audit copy or audit
// note is written, and no bytes are returned.

import { expect, it as vitestIt } from 'vitest';
import type { ReadAuditNote, ReadRequest } from '../../packages/core-runtime/src/index.ts';
import { awaitParked, racer, type Schedules } from './schedules-harness.ts';
import {
  FRAGMENT,
  fingerprint,
  leaseOf,
  noDatabase,
  readAs,
  useAw02World,
  w,
} from './aw-02-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useAw02World('aw02race');

interface Release {
  /** Commit the release, letting a read parked on the lease row through. */
  commit(): Promise<void>;
}

/** Release the lease on a third connection and hold the transaction open. */
async function releaseHeld(owner: Schedules, leaseId: string): Promise<Release> {
  const database = racer(owner);
  let commit!: () => void;
  const gate = new Promise<void>((resolve) => {
    commit = resolve;
  });
  let updated!: () => void;
  const ready = new Promise<void>((resolve) => {
    updated = resolve;
  });
  const done = database.withBusiness(owner.business, async (tx) => {
    await tx.query(
      `update public.leases set state = 'released', released_at = now()
        where business_id = $1 and id = $2`,
      [owner.business, leaseId],
    );
    updated();
    await gate;
  });
  await ready;
  return {
    async commit() {
      commit();
      await done;
      await database.close();
    },
  };
}

async function ownRequest(): Promise<ReadRequest> {
  const leaseId = String(w.alphaWork.picked['leaseId']);
  const lease = await leaseOf(w.alpha, leaseId);
  return {
    leaseId,
    holderActorId: lease.holder_actor_id,
    runId: lease.run_id,
    stepId: null,
    path: FRAGMENT,
  };
}

it('AW-02 lease race: a lease released while the read waits on it records nothing and returns no bytes', async () => {
  const request = await ownRequest();
  const before = await fingerprint(w.alpha);
  const release = await releaseHeld(w.alpha, request.leaseId);
  const notes: ReadAuditNote[] = [];
  const reading = readAs(w.alpha, request, notes);
  const first = await Promise.race([
    reading.then(() => 'finished while the release was uncommitted'),
    awaitParked(w.alpha, 'leases', 1).then(() => 'parked on the lease'),
  ]);
  await release.commit();
  expect(first).toBe('parked on the lease');
  expect(await reading).toContain('LEASE_NOT_OWNED');
  expect(notes).toEqual([]);
  expect(await fingerprint(w.alpha)).toBe(before);
}, 60_000);
