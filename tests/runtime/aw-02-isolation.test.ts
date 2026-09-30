// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-02 isolation: the pinned-file stores and the pinned read, across another
// business, another client in the same business, and another person's agent
// under its own live delegation. Each crossing is answered in the exact bytes
// of a made-up lease, writes nothing and reads nothing. The owner's own read
// then goes through, so the refusals are not a read that never works.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import type { ReadAuditNote, ReadRequest } from '../../packages/core-runtime/src/index.ts';
import {
  FRAGMENT,
  anotherPersonsAgent,
  clientOnItsOwnTask,
  fingerprint,
  leaseOf,
  noDatabase,
  readAs,
  sqlstate,
  useAw02World,
  w,
} from './aw-02-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useAw02World('aw02iso');

async function ownRequest(): Promise<ReadRequest> {
  const lease = await leaseOf(w.alpha, w.alphaWork.picked['leaseId']);
  return {
    leaseId: String(w.alphaWork.picked['leaseId']),
    holderActorId: lease.holder_actor_id,
    runId: lease.run_id,
    stepId: null,
    path: FRAGMENT,
  };
}

/** What bravo sees of alpha's rows from inside its own business: nothing. */
async function bravoSeesOfAlpha(runId: string): Promise<readonly number[]> {
  return await w.bravo.db.app.withBusiness(w.bravo.business, async (tx) => [
    (
      await tx.query('select 1 from public.run_definition_pins where business_id = $1', [
        w.alpha.business,
      ])
    ).length,
    (
      await tx.query('select 1 from public.bootstrap_reads where business_id = $1', [
        w.alpha.business,
      ])
    ).length,
    (await tx.query('select 1 from public.run_definition_pins where run_id = $1', [runId])).length,
  ]);
}

/** Bravo planting a ledger row on alpha's run. */
async function bravoPlants(runId: string): Promise<string> {
  return await sqlstate(
    async () =>
      await w.bravo.db.app.withBusiness(
        w.bravo.business,
        async (tx) =>
          await tx.query(
            `insert into public.bootstrap_reads
               (business_id, id, run_id, sequence, path, content_digest, content_size, is_entry)
             values ($1, $2, $3, 9, 'x.md', $4, 1, false)`,
            [w.alpha.business, randomUUID(), runId, 'a'.repeat(64)],
          ),
      ),
  );
}

it('AW-02 isolation: another business, another client, another person under a live delegation', async () => {
  const notes: ReadAuditNote[] = [];
  const mine = await ownRequest();
  const madeUp = await readAs(
    w.alpha,
    { ...mine, leaseId: randomUUID(), runId: randomUUID() },
    notes,
  );
  expect(JSON.parse(madeUp)).toMatchObject({ code: 'LEASE_NOT_OWNED' });
  const before = await fingerprint(w.alpha);

  // 1. Another business: bravo presents alpha's lease and run, and alpha bravo's.
  const bravoLease = await leaseOf(w.bravo, w.bravoWork.picked['leaseId']);
  const theirs = {
    ...mine,
    leaseId: String(w.bravoWork.picked['leaseId']),
    holderActorId: bravoLease.holder_actor_id,
    runId: bravoLease.run_id,
  };
  expect([await readAs(w.bravo, mine, notes), await readAs(w.alpha, theirs, notes)]).toStrictEqual([
    madeUp,
    madeUp,
  ]);
  expect(await bravoSeesOfAlpha(mine.runId)).toStrictEqual([0, 0, 0]);
  expect(await bravoPlants(mine.runId)).toBe('42501');

  // 2. Another client in the same business, holding a grant on its own task only.
  const clientX = await clientOnItsOwnTask(w.alpha);
  expect(await readAs(w.alpha, { ...mine, holderActorId: clientX }, notes)).toBe(madeUp);

  // 3. Another person's agent under its own live delegation: as the holder of
  // our lease, and with its own lease on our run.
  const other = await anotherPersonsAgent(w.alpha);
  const asHolder = await readAs(w.alpha, { ...mine, holderActorId: other.holder_actor_id }, notes);
  const ownLease = await readAs(
    w.alpha,
    { ...mine, leaseId: other.leaseId, holderActorId: other.holder_actor_id },
    notes,
  );
  expect([asHolder, ownLease]).toStrictEqual([madeUp, madeUp]);
  expect(await fingerprint(w.alpha)).toBe(before);
  expect(notes).toStrictEqual([]);

  // The owner's own read goes through: one ledger row and one audit event.
  expect(await readAs(w.alpha, mine, notes)).toBe('read');
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ runId: mine.runId, path: FRAGMENT, sequence: 2 });
}, 180_000);
