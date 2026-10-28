// SPDX-License-Identifier: AGPL-3.0-only
//
// #2277 (S2282-1): once a person writes off a step's attempt, at nothing or
// above, no hold for that step dispatches it again. The reconciliation pass
// proves the first attempt's effect absent and reserves a replacement for the
// step on its own hold; a person then writes the first attempt off. The
// write-off stops that replacement, as `happened` does: its hold goes back,
// and one already picked up loses its lease and never dispatches. A pickup of
// it afterwards is refused, and it writes nothing and moves no money. With no
// write-off, or after a person says nothing happened, the same replacement is
// picked up and dispatches.

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

let s: Schedules;
const h = t3d1Harness(() => s);

beforeAll(async () => {
  if (url === undefined) return;
  s = await openSchedules('replacement_written_off', 1_000_000);
  await openBilling(s);
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

/** A step held unknown, its effect proved absent by the pass, and the replacement it reserved. */
async function absentWithReplacement() {
  const w = await h.unknownStep({ applied: false, room: true });
  expect(await h.reconcile()).toMatchObject([{ attemptId: w.attemptId, answer: 'absent' }]);
  const replacement = await h.replacement(w);
  expect(replacement).toBeDefined();
  return { w, replacement };
}

/** Every attempt on the work's step, oldest first, by state. */
async function stepStates(w: Work) {
  const found = await rows<{ readonly state: string }>(
    s,
    `select att.state from public.attempts att
      where att.business_id = $1
        and att.step_id = (select step_id from public.attempts where business_id = $1 and id = $2)
      order by att.created_at, att.id`,
    [s.business, w.attemptId],
  );
  return found.map((one) => one.state);
}

/** The replacement picked up: the work a fresh worker holds for the step. */
async function pickedUp(w: Work, replacement: string | undefined): Promise<Work> {
  const picked = await pickup(s, replacement);
  return {
    ...w,
    picked,
    credential: String(picked['credential']),
    attemptId: String(picked['attemptId']),
  };
}

/** The replacement picked up and dispatched: the step runs again. */
async function runsAgain(w: Work, replacement: string | undefined) {
  await h.t2d.dispatched(await pickedUp(w, replacement));
  return await stepStates(w);
}

/** The replacement's hold and lease, and the envelope, once the step is written off. */
async function stoppedBy(w: Work, replacement: string | undefined, amount: number) {
  appliedDetail(await asPerson(s, writeOffBody(w, amount)), 'budget.write_off');
  const [hold] = await rows(
    s,
    `select res.state, att.state as attempt_state, l.state as lease_state,
            (d.revoked_at is not null) as delegation_revoked
       from public.reservations res
       join public.attempts att on att.business_id = res.business_id and att.reservation_id = res.id
       left join public.leases l on l.business_id = res.business_id and l.id = att.lease_id
       left join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
      where res.business_id = $1 and res.id = $2`,
    [s.business, replacement],
  );
  return { hold, envelope: await h.envelope(w) };
}

/** Closed at `amount`, the written-off hold is the envelope's only spend. */
const givenBack = (amount: number) => ({ held: '0', actual: String(amount) });

/** Written off at `amount`, then a pickup of its replacement: the answer and what it changed. */
async function writtenOffThenReplacementPickedUp(amount: number) {
  const { w, replacement } = await absentWithReplacement();
  appliedDetail(await asPerson(s, writeOffBody(w, amount)), 'budget.write_off');
  const before = await h.t3b.snapshot();
  const picked = await asAgent(s, {
    command: 'task.pickup',
    operationId: randomUUID(),
    reservationId: replacement,
    leaseSeconds: 600,
  });
  return {
    picked: codeOf(picked),
    after: await h.t3b.snapshot(),
    before,
    dispatched: (await stepStates(w)).filter((state) => state === 'dispatched'),
  };
}

describe.skipIf(url === undefined)(
  'a replacement reserved before its step was written off',
  { timeout: 60_000 },
  () => {
    it.each([0, 700])(
      'written off at %i, its replacement is refused at pickup with nothing written and no money moved',
      async (amount) => {
        const { before, ...seen } = await writtenOffThenReplacementPickedUp(amount);
        expect(seen).toStrictEqual({
          picked: 'RESERVATION_NOT_CLAIMABLE',
          after: before,
          dispatched: [],
        });
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

describe.skipIf(url === undefined)(
  'a write-off stops the replacement reserved before it',
  { timeout: 60_000 },
  () => {
    it.each([0, 700])(
      'written off at %i, the replacement reserved before it is stopped and its hold goes back',
      async (amount) => {
        const { w, replacement } = await absentWithReplacement();
        expect(await stoppedBy(w, replacement, amount)).toMatchObject({
          hold: { state: 'abandoned', attempt_state: 'abandoned', lease_state: null },
          envelope: givenBack(amount),
        });
      },
    );

    it.each([0, 700])(
      'written off at %i after its replacement was picked up, the replacement never dispatches',
      async (amount) => {
        const { w, replacement } = await absentWithReplacement();
        const next = await pickedUp(w, replacement);
        expect(await stoppedBy(w, replacement, amount)).toMatchObject({
          hold: {
            state: 'abandoned',
            attempt_state: 'abandoned',
            lease_state: 'released',
            delegation_revoked: true,
          },
          envelope: givenBack(amount),
        });
        const dispatch = await h.t2d.held(next, { command: 'task.dispatch' });
        expect(codeOf(dispatch)).not.toBe('applied');
        expect(await stepStates(w)).toStrictEqual([
          amount > 0 ? 'settled' : 'abandoned',
          'abandoned',
        ]);
      },
    );
  },
);
