// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 receipt atomic (TR-S-R4-10): `receipt written` runs under the worker
// lease, in the same transaction as the observed publish or revert result. A
// receipt that cannot be written leaves the state where it was; a lease that is
// not live, not this task's or not at this fence writes nothing; nothing is
// recorded published before the approval.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c80World, type C80World } from './c80-world.ts';
import {
  recordObservedResult,
  type ObservedResult,
} from '../../packages/core-records/src/site/correction-receipts.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C80 receipt atomic: DATABASE_URL is unset, so nothing ran.');

let w: C80World;
let lease: { leaseId: string; fence: number; taskId: string };

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('c80rcpt');
  await w.setApprover(w.ben.personId);
  const picked = await w.world.pickUp(w.cal, 'publish the About correction');
  const rows = await w.world.db.admin.execute<{ readonly id: string; readonly fence: string }>(
    `select id, fence::text as fence from public.leases where task_id = $1 and state = 'live'`,
    [picked.taskId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no live lease after pickup');
  lease = { leaseId: row.id, fence: Number(row.fence), taskId: picked.taskId };
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

async function correction(approved: boolean): Promise<string> {
  const detail = detailOf(await w.request(w.ava, { taskId: lease.taskId }));
  const id = String(detail['correctionId']);
  if (approved)
    expect(codeOf(await w.approve(w.ben, id, String(detail['versionId'])))).toBe('not-a-refusal');
  return id;
}

const record = async (result: Partial<ObservedResult> & { correctionId: string }) =>
  await w.world.db.app.withBusiness(
    w.world.business,
    async (tx) =>
      await recordObservedResult(tx, {
        leaseId: lease.leaseId,
        fence: lease.fence,
        step: 'publish',
        outcome: 'live',
        observations: { servedRevision: 'rev-2' },
        ...result,
      }),
  );

describe.skipIf(serverUrl === undefined)('C80 receipt atomic', () => {
  it('moves the state and writes its receipt together, publish then revert', async () => {
    const id = await correction(true);
    expect(await record({ correctionId: id })).toMatchObject({ ok: true });
    expect([await w.stateOf(id), await w.receiptsOf(id)]).toEqual(['live', 1]);
    expect(await record({ correctionId: id, step: 'revert', outcome: 'reverted' })).toMatchObject({
      ok: true,
    });
    expect([await w.stateOf(id), await w.receiptsOf(id)]).toEqual(['reverted', 2]);
  });

  it('leaves the state unmoved when the receipt cannot be written', async () => {
    const id = await correction(true);
    await expect(record({ correctionId: id, observations: [] as never })).rejects.toThrow(
      /live_correction_receipts_observations_object/u,
    );
    expect([await w.stateOf(id), await w.receiptsOf(id)]).toEqual(['approved', 0]);
  });

  it('records nothing published before the approval', async () => {
    const id = await correction(false);
    expect(await record({ correctionId: id })).toEqual({ ok: false, code: 'GATE_NOT_APPROVED' });
    expect([await w.stateOf(id), await w.receiptsOf(id)]).toEqual(['requested', 0]);
  });
});

describe.skipIf(serverUrl === undefined)('C80 receipt atomic, the worker lease', () => {
  it('writes nothing at a stale fence or on a lease of another task', async () => {
    const id = await correction(true);
    expect(await record({ correctionId: id, fence: lease.fence + 1 })).toEqual({
      ok: false,
      code: 'LEASE_NOT_OWNED',
    });
    const other = detailOf(await w.request(w.ava));
    const otherId = String(other['correctionId']);
    await w.approve(w.ben, otherId, String(other['versionId']));
    expect(await record({ correctionId: otherId })).toEqual({ ok: false, code: 'LEASE_NOT_OWNED' });
    expect([await w.stateOf(id), await w.receiptsOf(id)]).toEqual(['approved', 0]);
    expect([await w.stateOf(otherId), await w.receiptsOf(otherId)]).toEqual(['approved', 0]);
  });

  it('keeps receipts append only', async () => {
    const id = await correction(true);
    await record({ correctionId: id });
    await expect(
      w.world.db.app.withBusiness(w.world.business, async (tx) => {
        await tx.query('delete from public.live_correction_receipts where correction_id = $1', [
          id,
        ]);
      }),
    ).rejects.toThrow(/append only|permission denied/u);
    expect(await w.receiptsOf(id)).toBe(1);
  });
});
