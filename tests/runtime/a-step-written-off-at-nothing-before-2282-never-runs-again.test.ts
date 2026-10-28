// SPDX-License-Identifier: AGPL-3.0-only
//
// #2283: a write-off at nothing recorded before #2282 left the attempt
// `abandoned/abandoned` and, when its calls had spent, the hold `actual` with
// no cause: the same rows a person's `nothing_happened` leaves. An attempt's
// outcome never changes (0014), so those rows stay. The write-off's applied
// operation, written in its own transaction and never changed, still says what
// happened, so a pickup of that hold, or of a replacement the reconciliation
// pass reserved for the step before the write-off, is refused and the step
// never runs again (#2277), with no money moved. One business's register never
// marks another business's step.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  aRealWriteOff,
  heldUnknown,
  plantWriteOff,
  writtenOffBefore2282,
} from './legacy-write-off-world.ts';
import { asAgent, codeOf, openSchedules, type Schedules } from './schedules-harness.ts';
import { holdOf } from './t3c-harness.ts';
import { openBilling, t3d1Harness } from './t3d1-harness.ts';
import { holdsOf, moneyOf, roomyWork, spend, stopWorker } from './version-room-world.ts';
import { attemptOf } from './written-off-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/a-step-written-off-at-nothing-before-2282-never-runs-again: DATABASE_URL is unset, so nothing below ran.',
  );
}

let s: Schedules;
let other: Schedules;
const h = t3d1Harness(() => s);

async function open(part: string): Promise<Schedules> {
  const opened = await openSchedules(part, 1_000_000);
  await openBilling(opened);
  await opened.db.app.withBusiness(opened.business, async (tx) => {
    await grantTo(tx, opened.decider, 'manage');
    await grantTo(tx, opened.decider, 'decide', undefined, false, 'gate');
  });
  return opened;
}

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await open('legacy_zero_write_off');
  other = await open('legacy_zero_write_off_other');
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
  await other?.db.drop();
});

const pickupOf = async (at: Schedules, reservationId: unknown) =>
  await asAgent(at, {
    command: 'task.pickup',
    operationId: randomUUID(),
    reservationId,
    leaseSeconds: 600,
  });

describe.skipIf(serverUrl === undefined)('a step written off at nothing before #2282', () => {
  it('reads as written off from its applied operation, so a pickup is refused with nothing moved', async () => {
    const template = await aRealWriteOff(s);
    const held = await heldUnknown(s);
    await writtenOffBefore2282(
      s,
      { reservationId: held.first, attemptId: held.attemptId, taskId: held.work.taskId },
      template,
    );
    // The rows a person's `nothing_happened` would leave: only the operation tells them apart.
    expect(await holdOf(s, { attemptId: held.attemptId })).toMatchObject({
      attempt_state: 'abandoned',
      outcome: 'abandoned',
      reservation_state: 'actual',
      reservation_actual: '300',
      classified_cause: null,
    });
    const money = await moneyOf(s, held.work, held.versionId);

    const picked = await pickupOf(s, held.first);
    expect({
      picked: codeOf(picked),
      held: (await holdsOf(s, held.versionId)).filter((hold) => hold.state === 'held'),
      money: await moneyOf(s, held.work, held.versionId),
    }).toEqual({ picked: 'RESERVATION_NOT_CLAIMABLE', held: [], money });
  });

  it("never reads one business's write-off onto another business's step", async () => {
    const template = await aRealWriteOff(s);
    // Another business's step, its worker stopped after spending 300: the classifier closed
    // its hold at that spend, and a pickup replaces it on what is left.
    const { work, versionId, first } = await roomyWork(other);
    await spend(other, first, 300);
    await stopWorker(other, work.picked);
    const attemptId = await attemptOf(other, first);
    // This business's register names that attempt as written off.
    await s.db.app.withBusiness(s.business, async (tx) => {
      await plantWriteOff(tx, template, { attemptId, taskId: work.taskId });
    });

    expect(codeOf(await pickupOf(other, first))).toBe('applied');
    const held = (await holdsOf(other, versionId)).filter((hold) => hold.state === 'held');
    expect(held.map((hold) => hold.held)).toEqual(['200']);
  });
});

describe.skipIf(serverUrl === undefined)(
  'a replacement reserved before a step written off at nothing before #2282',
  () => {
    it('is refused at pickup, with nothing written or moved', async () => {
      const template = await aRealWriteOff(s);
      // Held unknown after spending 300; the pass proves its effect absent and reserves a
      // replacement on its own hold. Then the old write-off at nothing closes the first hold.
      const w = await h.unknownStep({ applied: false, room: true });
      await spend(s, w.decision['reservationId'], 300);
      await h.reconcile();
      const replacement = await h.replacement(w);
      expect(replacement).toBeDefined();
      await writtenOffBefore2282(
        s,
        { reservationId: w.decision['reservationId'], attemptId: w.attemptId, taskId: w.taskId },
        template,
      );
      const before = await h.t3b.snapshot();

      const picked = await pickupOf(s, replacement);
      expect({ picked: codeOf(picked), after: await h.t3b.snapshot() }).toStrictEqual({
        picked: 'RESERVATION_NOT_CLAIMABLE',
        after: before,
      });
    });
  },
);
