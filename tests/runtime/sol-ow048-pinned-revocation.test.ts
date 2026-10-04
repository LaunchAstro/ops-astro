// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #423: Sol's OW-048 criterion 3 proof, unchanged
// (R/sol/proofs/OW-048-4126931d1.patch); the file's other criterion is not
// this issue's.
import { expect, it } from 'vitest';
import { revokeDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { readPinned, type ReadAuditNote } from '../../packages/core-runtime/src/index.ts';
import { liveWork } from './schedules-harness.ts';
import {
  FILES,
  FRAGMENT,
  fingerprint,
  leaseOf,
  seedPin,
  sourceOf,
  useAw02World,
  w,
} from './aw-02-world.ts';

useAw02World('solow048');

it('Sol proof, criterion 3: a revoked delegation cannot read pinned instructions through its still-live lease', async () => {
  if (process.env['DATABASE_URL'] === undefined) throw new Error('Postgres is required');
  const owner = w.alpha;
  const work = await liveWork(owner, 'Sol OW-048 revoked reader', 1_000);
  const leaseId = String(work.picked['leaseId']);
  const lease = await leaseOf(owner, leaseId);
  await seedPin(owner, lease.run_id);
  const request = {
    leaseId,
    holderActorId: lease.holder_actor_id,
    runId: lease.run_id,
    stepId: null,
    path: FRAGMENT,
  };
  const notes: ReadAuditNote[] = [];
  const source = sourceOf(FILES);
  const read = async () =>
    await owner.db.app.withBusiness(
      owner.business,
      async (tx) =>
        await readPinned(tx, request, source, async (_inner, note) => {
          notes.push(note);
        }),
    );
  expect((await read()).ok, 'the live owner can read before revocation').toBe(true);
  await owner.db.app.withBusiness(owner.business, async (tx) => {
    await revokeDelegation(tx, String(work.picked['delegationId']));
  });
  const [stillLive] = await owner.db.admin.execute<{ live: boolean; revoked: boolean }>(
    `select l.state = 'live' and l.expires_at > clock_timestamp() as live,
            d.revoked_at is not null as revoked
       from public.leases l
       join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
      where l.id = $1`,
    [leaseId],
  );
  expect(stillLive).toEqual({ live: true, revoked: true });
  const before = await fingerprint(owner);
  source.asked.length = 0;
  notes.length = 0;
  const denied = await read();
  expect(denied.ok, 'revocation must stop the pinned read before it returns bytes').toBe(false);
  expect(source.asked, 'revoked authority must not reach the instruction source').toEqual([]);
  expect(notes).toEqual([]);
  expect(await fingerprint(owner)).toBe(before);
});
