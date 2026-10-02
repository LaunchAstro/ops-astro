// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-BATCH-2 batch 3a, defect 4: model-call spend never reaches the
// reservation. The broker settles only the model_calls row
// (core-custody broker-settle.ts), and the handback's classifier then abandons
// the reservation with no actual (core-runtime recovery/classifier.ts,
// handback.ts). So a priced call vanishes from the envelope, and a call held
// as an unknown liability has its hold released by an ordinary handback.
//
// Red on 8cbd0e422 (batch 3a before its fix squash). Green once the handback (or the settle) carries settled
// model-call cost into the envelope's actual, and a liability_unknown call
// keeps the reservation's hold instead of letting it be abandoned.

import { expect, it as vitestIt } from 'vitest';
import {
  appliedDetail,
  asAgent,
  handbackBody,
  liveWork,
  type Work,
} from '../runtime/schedules-harness.ts';
import { call, noDatabase, rowsOf, s, useBrokerWorld, world } from './broker-world.ts';
import { moneyOf, one } from './budget-answers-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('rv3a4');

const runOf = async (work: Work): Promise<string> =>
  (
    await one<{ run_id: string }>(`select run_id from public.leases where id = $1`, [
      work.picked['leaseId'],
    ])
  ).run_id;

const handBack = async (work: Work) =>
  await asAgent(s, handbackBody(work.picked), String(work.picked['credential']));

it('REVIEW-3A-4: a model call settled at 100 is counted in the envelope actual after a completed handback', async () => {
  const work = await liveWork(s, 'rv3a4 settled spend', 2_000);
  const runId = await runOf(work);
  world.provider.mode('answer');
  const called = await call(work);
  // Setup: one call, settled at the replay price of 40 + 2 * 30 = 100.
  expect(called).toMatchObject({ ok: true, actualMinor: 100 });
  const [row] = await rowsOf((called as { callId: string }).callId);
  expect(row?.['state']).toBe('settled');
  expect(Number(row?.['actual_minor'])).toBe(100);
  const before = await moneyOf(runId);

  appliedDetail(await handBack(work), 'task.handback');

  const after = await moneyOf(runId);
  // The defect: the reservation is abandoned with actual 0, so the 100 spent
  // on the model never reaches the envelope or the cap.
  expect(
    Number(after.envelope_actual),
    'the envelope actual must include the 100 the model call settled at',
  ).toBe(Number(before.envelope_actual) + 100);
  expect(after.reservation).not.toBe('abandoned');
});

it('REVIEW-3A-4: a model call held as liability_unknown keeps the reservation held through a completed handback', async () => {
  const work = await liveWork(s, 'rv3a4 unknown liability', 2_000);
  const runId = await runOf(work);
  world.provider.mode('costly');
  const called = await call(work);
  // Setup: the answer prices above the 500 hold, so the call is held unknown.
  expect(called).toMatchObject({ ok: false, code: 'LIABILITY_UNKNOWN', heldMinor: 500 });
  expect(await rowsOf((called as { callId: string }).callId)).toMatchObject([
    { state: 'liability_unknown' },
  ]);
  const before = await moneyOf(runId);
  expect(before.reservation).toBe('held');

  await handBack(work);

  const after = await moneyOf(runId);
  // The defect: the classifier abandons the reservation and releases the
  // whole hold, though a call on it may have cost up to its maximum.
  expect(
    after.reservation,
    'the reservation must not be abandoned under an unknown liability',
  ).not.toBe('abandoned');
  expect(
    Number(after.envelope_held),
    "the held call's 500 must stay held on the envelope",
  ).toBeGreaterThanOrEqual(500);
});
