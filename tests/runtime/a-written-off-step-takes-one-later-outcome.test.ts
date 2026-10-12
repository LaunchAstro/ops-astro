// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proofs (round 2 on #1387, #1314): a written-off step takes one later
// outcome. A recorded `happened` stops a fresh `nothing_happened` restarting
// the work, and an earlier attempt on the step does not stop the latest
// written-off attempt from recovering.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  appliedDetail,
  asPerson,
  openSchedules,
  pickup,
  type Schedules,
} from './schedules-harness.ts';
import { openBilling, t3d1Harness } from './t3d1-harness.ts';
import { holdOf, writeOffBody } from './t3c-harness.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)('Sol write-off outcome proofs', () => {
  let s: Schedules;
  const h = t3d1Harness(() => s);
  beforeAll(async () => {
    s = await openSchedules('sol1387outcome', 1_000_000);
    await openBilling(s);
  }, 180_000);
  afterAll(async () => {
    await s?.db.drop();
  });

  it('Sol proof, criterion 4: a recorded happened outcome prevents a fresh operation from restarting written-off work', async () => {
    const w = await h.unknownStep({ applied: false, room: true });
    appliedDetail(await asPerson(s, writeOffBody(w, 1_000)), 'budget.write_off');
    appliedDetail(await h.outcome(w, 'happened'), 'budget.record_outcome');
    expect(await h.replacement(w)).toBeUndefined();
    expect(await holdOf(s, w)).toMatchObject({
      reservation_actual: '1000',
      envelope_actual: '1000',
    });
    const second = await h.outcome(w, 'nothing_happened');
    expect(await h.replacement(w), JSON.stringify(second)).toBeUndefined();
  });

  it('Sol proof, criterion 4: an earlier attempt does not prevent recovery of the latest written-off attempt', async () => {
    const original = await h.unknownStep({ applied: false, room: true });
    await h.reconcile();
    const picked = await pickup(s, await h.replacement(original));
    const next = {
      ...original,
      picked,
      credential: String(picked['credential']),
      attemptId: String(picked['attemptId']),
    };
    appliedDetail(await h.t2d.held(next, { command: 'task.dispatch' }), 'task.dispatch');
    await h.t3b.expire(next);
    await h.t3b.sweep();
    appliedDetail(await asPerson(s, writeOffBody(next, 1_000)), 'budget.write_off');
    appliedDetail(
      await asPerson(s, {
        command: 'budget.top_up',
        operationId: randomUUID(),
        recordId: next.taskId,
        fromMaximumMinor: 5_000,
        amountMinor: 2_500,
      }),
      'budget.top_up',
    );
    const recorded = appliedDetail(
      await h.outcome(next, 'nothing_happened'),
      'budget.record_outcome',
    );
    expect(await h.envelope(next)).toMatchObject({ maximum: '7500', actual: '1000' });
    expect(await h.replacement(next), JSON.stringify(recorded)).toBeDefined();
  });
});
