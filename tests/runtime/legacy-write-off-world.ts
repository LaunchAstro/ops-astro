// SPDX-License-Identifier: AGPL-3.0-only
//
// A write-off at nothing as it was recorded before #2282, shared by the proofs that read one
// (`a-step-written-off-at-nothing-before-2282-never-runs-again`,
// `a-replacement-held-for-a-step-written-off-before-2282-goes-back`): a real write-off's
// operation, and the old statements that left the attempt `abandoned/abandoned`.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import { closeHold } from '../../packages/core-runtime/src/close-hold.ts';
import { resolveHeldCalls } from '../../packages/core-runtime/src/recovery/broker-effect.ts';
import { appliedDetail, asPerson, rows, type Schedules, type Work } from './schedules-harness.ts';
import { writeOffBody } from './t3c-harness.ts';
import { dispatchedCall, roomyWork, spend, stopWorker, sweep } from './version-room-world.ts';
import { attemptOf } from './written-off-world.ts';

export interface Operation {
  readonly actor_id: string;
  readonly payload_digest: string;
  readonly result: { readonly detail: Readonly<Record<string, unknown>> };
}

/**
 * Live work on a 500 hold that spent 300 and sent a call of 200 that never
 * answered, held unknown by the sweep once the worker's authority goes.
 */
export async function heldUnknown(
  at: Schedules,
): Promise<{ work: Work; versionId: unknown; first: unknown; attemptId: string }> {
  const { work, versionId, first } = await roomyWork(at);
  await spend(at, first, 300);
  await dispatchedCall(at, first, 200);
  await stopWorker(at, work.picked);
  await sweep(at);
  const attemptId = await attemptOf(at, first);
  return { work, versionId, first, attemptId };
}

/**
 * What `writeOff` did at nothing before #2282 (13841a2b0), statement for statement: the
 * attempt abandoned under `abandoned`, the hold closed at what its calls spent under the
 * write-off, and the held calls resolved; with the operation the register kept for it,
 * shaped as a real write-off's own (`template`), naming this attempt. It stopped no
 * replacement the pass had reserved for the step.
 */
export async function writtenOffBefore2282(
  s: Schedules,
  held: { readonly reservationId: unknown; readonly attemptId: string; readonly taskId: string },
  template: Operation,
): Promise<void> {
  const [hold] = await rows<{ envelope_id: string }>(
    s,
    'select envelope_id from public.reservations where business_id = $1 and id = $2',
    [s.business, held.reservationId],
  );
  const reservationId = String(held.reservationId);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await tx.query(
      `update public.attempts set state = 'abandoned', outcome = 'abandoned'
        where business_id = $1 and id = $2`,
      [tx.businessId, held.attemptId],
    );
    await closeHold(
      tx,
      { reservationId, envelopeId: String(hold?.envelope_id) },
      { cause: 'written_off', causeId: held.attemptId },
      300n,
    );
    await resolveHeldCalls(tx, reservationId, 'written_off', s.decider.personId);
    await plantWriteOff(tx, template, { attemptId: held.attemptId, taskId: held.taskId });
  });
}

/** The register's applied write-off, shaped as `template` and naming `named`'s attempt. */
export async function plantWriteOff(
  tx: TenantQuery,
  template: Operation,
  named: { readonly attemptId: string; readonly taskId: string },
): Promise<void> {
  const detail = { ...template.result.detail, attemptId: named.attemptId };
  await tx.query(
    `insert into public.operations
       (business_id, id, operation_id, command, actor_id, payload_digest, outcome, result,
        record_id, revision)
     values ($1, $2, $3, 'budget.write_off', $4, $5, 'applied', $6::text::jsonb, $7, null)`,
    [
      tx.businessId,
      randomUUID(),
      randomUUID(),
      template.actor_id,
      template.payload_digest,
      JSON.stringify({ ...template.result, recordId: named.taskId, detail }),
      named.taskId,
    ],
  );
}

/** A real write-off at nothing, applied today: the operation the register keeps for one. */
export async function aRealWriteOff(s: Schedules): Promise<Operation> {
  const held = await heldUnknown(s);
  const body = writeOffBody({ taskId: held.work.taskId, attemptId: held.attemptId }, 0);
  appliedDetail(await asPerson(s, body), 'budget.write_off');
  const [operation] = await rows<Operation>(
    s,
    `select actor_id, payload_digest, result from public.operations
      where business_id = $1 and command = 'budget.write_off'
        and result -> 'detail' ->> 'attemptId' = $2`,
    [s.business, held.attemptId],
  );
  expect(operation?.result.detail).toMatchObject({ amountMinor: 0, state: 'applied' });
  return operation as Operation;
}
