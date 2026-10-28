// SPDX-License-Identifier: AGPL-3.0-only
//
// #2277 (S2282-1): once a person writes off a step's attempt, at nothing or
// above, no hold for that step dispatches it again. The reconciliation pass
// proves the first attempt's effect absent and reserves a replacement for the
// step on its own hold; a person then writes the first attempt off. A pickup
// of that replacement is refused, and it writes nothing and moves no money.
// With no write-off, or after a person says nothing happened, the same
// replacement is picked up and dispatches.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  codeOf,
  openSchedules,
  pickup,
  rows,
  type Schedules,
} from './schedules-harness.ts';
import { writeOffBody } from './t3c-harness.ts';
import { openBilling, t3d1Harness } from './t3d1-harness.ts';
import type { Work } from './t2d-harness.ts';

const url = databaseUrlFromEnvironment();

if (url === undefined) {
  console.warn(
    'runtime/a-replacement-reserved-before-its-step-was-written-off-never-runs: DATABASE_URL is unset, so nothing below ran.',
  );
}

describe.skipIf(url === undefined)(
  'a replacement reserved before its step was written off',
  { timeout: 60_000 },
  () => {
    let s: Schedules;
    const h = t3d1Harness(() => s);

    beforeAll(async () => {
      s = await openSchedules('replacement_written_off', 1_000_000);
      await openBilling(s);
    }, 180_000);

    afterAll(async () => {
      await s?.db.drop();
    });

    /** A step held unknown, its effect proved absent by the pass, and the replacement it reserved. */
    const absentWithReplacement = async () => {
      const w = await h.unknownStep({ applied: false, room: true });
      expect(await h.reconcile()).toMatchObject([{ attemptId: w.attemptId, answer: 'absent' }]);
      const replacement = await h.replacement(w);
      expect(replacement).toBeDefined();
      return { w, replacement };
    };

    /** Every attempt on the work's step, oldest first, by state. */
    const stepStates = async (w: Work) =>
      (
        await rows<{ readonly state: string }>(
          s,
          `select att.state from public.attempts att
            where att.business_id = $1
              and att.step_id = (select step_id from public.attempts
                                  where business_id = $1 and id = $2)
            order by att.created_at, att.id`,
          [s.business, w.attemptId],
        )
      ).map((one) => one.state);

    /** The replacement picked up and dispatched: the step runs again. */
    const runsAgain = async (w: Work, replacement: string | undefined) => {
      const picked = await pickup(s, replacement);
      await h.t2d.dispatched({
        ...w,
        picked,
        credential: String(picked['credential']),
        attemptId: String(picked['attemptId']),
      });
      return await stepStates(w);
    };

    it.each([0, 700])(
      'written off at %i, its replacement is refused at pickup with nothing written and no money moved',
      async (amount) => {
        const { w, replacement } = await absentWithReplacement();
        appliedDetail(await asPerson(s, writeOffBody(w, amount)), 'budget.write_off');
        const before = await h.t3b.snapshot();
        const picked = await asAgent(s, {
          command: 'task.pickup',
          operationId: randomUUID(),
          reservationId: replacement,
          leaseSeconds: 600,
        });
        expect({
          picked: codeOf(picked),
          after: await h.t3b.snapshot(),
          dispatched: (await stepStates(w)).filter((state) => state === 'dispatched'),
        }).toStrictEqual({ picked: 'RESERVATION_NOT_CLAIMABLE', after: before, dispatched: [] });
      },
    );

    it('with no write-off, the replacement is picked up and dispatches', async () => {
      const { w, replacement } = await absentWithReplacement();
      expect(await runsAgain(w, replacement)).toStrictEqual(['liability_unknown', 'dispatched']);
    });

    it('after a person says nothing happened, the replacement is picked up and dispatches', async () => {
      const { w, replacement } = await absentWithReplacement();
      appliedDetail(await h.outcome(w, 'nothing_happened'), 'budget.record_outcome');
      expect(await runsAgain(w, replacement)).toStrictEqual(['abandoned', 'dispatched']);
    });
  },
);
