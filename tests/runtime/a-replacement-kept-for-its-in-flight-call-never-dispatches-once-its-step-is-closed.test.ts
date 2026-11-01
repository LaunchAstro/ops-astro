// SPDX-License-Identifier: AGPL-3.0-only
//
// #2305: a replacement whose broker model call is in flight keeps its hold and lease when a
// person writes its step off (S2282-2) or records that the first attempt happened (#2289), so
// the call's answer is charged inside the envelope. Its worker must still never run the step
// again (#2277): once the call has answered, `task.dispatch` on the kept lease is refused under
// the step lock, with a refused audit row, and the envelope, the cap and the step's mark stay
// as they were. A step a person recorded `happened_differently` goes on, so its replacement
// still dispatches (S2355-1). Another business's replacement, whose step is closed nowhere
// there, still dispatches, whatever this business's register names. Custody's answer is stubbed: no
// provider is paid.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import { aRealWriteOff, plantWriteOff } from './legacy-write-off-world.ts';
import { closedWhileTheReplacementsCallIsOut } from './replacement-call-in-flight-world.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  capCommitted,
  codeOf,
  openSchedules,
  pickup,
  rows,
  seedSchedules,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';
import type { Work } from './t2d-harness.ts';
import { writeOffBody } from './t3c-harness.ts';
import { openBilling, t3d1Harness } from './t3d1-harness.ts';

const url = databaseUrlFromEnvironment();

if (url === undefined) {
  console.warn(
    'runtime/a-replacement-kept-for-its-in-flight-call-never-dispatches-once-its-step-is-closed: DATABASE_URL is unset, so nothing below ran.',
  );
}

type Harness = ReturnType<typeof t3d1Harness>;

let s: Schedules;
let other: Schedules;
const h = t3d1Harness(() => s);
const ho = t3d1Harness(() => other);

/** Billing, and manage for the decider. */
async function open(opened: Schedules): Promise<Schedules> {
  await openBilling(opened);
  await opened.db.app.withBusiness(
    opened.business,
    async (tx) => await grantTo(tx, opened.decider, 'manage'),
  );
  return opened;
}

beforeAll(async () => {
  if (url === undefined) return;
  s = await open(await openSchedules('kept_replacement_dispatch', 1_000_000));
  // The other business is a second tenant of the same database.
  other = await open(await seedSchedules(s.db, 'kept_replacement_dispatch_other', 1_000_000));
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

/** The money and the step's mark around the replacement: what a refused dispatch must not move. */
async function around(at: Schedules, ah: Harness, w: Work, picked: Detail) {
  const [mark] = await rows<Record<string, unknown>>(
    at,
    `select coalesce(step.dispatch_attempt_id = att.id, false) as marked,
            att.dispatch_marker, att.state
       from public.attempts att
       join public.planned_steps step on step.business_id = att.business_id and step.id = att.step_id
      where att.business_id = $1 and att.id = $2`,
    [at.business, picked['attemptId']],
  );
  return { envelope: await ah.envelope(w), cap: await capCommitted(at), mark };
}

/** The kept replacement's worker dispatches once its call answered: the answer and its audit. */
async function dispatchKept(at: Schedules, ah: Harness, w: Work, picked: Detail) {
  const before = await around(at, ah, w, picked);
  const operationId = randomUUID();
  const answer = await asAgent(
    at,
    {
      command: 'task.dispatch',
      operationId,
      leaseId: picked['leaseId'],
      fence: picked['fence'],
    },
    String(picked['credential']),
  );
  const audits = await rows<Record<string, unknown>>(
    at,
    `select outcome, refusal_code from public.audit_events
      where business_id = $1 and operation_id = $2 and command = 'task.dispatch'`,
    [at.business, operationId],
  );
  // A plain array: the driver's result array is a subclass a strict compare refuses (S2355-2).
  return {
    code: codeOf(answer),
    audits: [...audits],
    before,
    after: await around(at, ah, w, picked),
  };
}

/** `close` while the replacement's call is out; once it answers, the replacement dispatches. */
async function dispatchedAfter(at: Schedules, ah: Harness, close: (w: Work) => Promise<void>) {
  let closed: Work | undefined;
  const { seen, picked } = await closedWhileTheReplacementsCallIsOut(at, ah, async (w) => {
    closed = w;
    await close(w);
  });
  // The call answered and was charged on the kept hold (S2282-2, #2289).
  expect(seen).toMatchObject({ answer: true, answered: { hold: { lease_state: 'live' } } });
  if (closed === undefined) throw new Error('the call was never out');
  return await dispatchKept(at, ah, closed, picked);
}

const REFUSED = 'TRANSITION_NOT_PERMITTED';

/** Refused with its audit row, and nothing moved: no money, no mark. */
const refusedWithNothingMoved = (seen: Awaited<ReturnType<typeof dispatchKept>>) => {
  expect(seen.before.mark).toStrictEqual({
    marked: false,
    dispatch_marker: false,
    state: 'dispatched',
  });
  expect({ code: seen.code, audits: seen.audits, after: seen.after }).toStrictEqual({
    code: REFUSED,
    audits: [{ outcome: 'refused', refusal_code: REFUSED }],
    after: seen.before,
  });
};

describe.skipIf(url === undefined)(
  'a replacement kept for its in-flight call never dispatches once its step is closed',
  { timeout: 60_000 },
  () => {
    it.each([0, 700])(
      'written off at %i while the call is out, the dispatch after its answer is refused and moves nothing',
      async (amount) => {
        refusedWithNothingMoved(
          await dispatchedAfter(s, h, async (w) => {
            appliedDetail(await asPerson(s, writeOffBody(w, amount)), 'budget.write_off');
          }),
        );
      },
    );

    it('recorded as happened while the call is out, the dispatch after its answer is refused and moves nothing', async () => {
      refusedWithNothingMoved(
        await dispatchedAfter(s, h, async (w) => {
          appliedDetail(await h.outcome(w, 'happened'), 'budget.record_outcome');
        }),
      );
    });
  },
);

describe.skipIf(url === undefined)(
  'a step recorded as happened differently goes on',
  { timeout: 60_000 },
  () => {
    it('its replacement is picked up and dispatches', async () => {
      const w = await h.unknownStep({ applied: false, room: true });
      appliedDetail(await h.outcome(w, 'happened_differently'), 'budget.record_outcome');
      const replacement = await h.replacement(w);
      if (replacement === undefined) throw new Error('the step did not go on');
      const picked = await pickup(s, replacement);
      const next = { ...w, picked, credential: String(picked['credential']) };
      expect(codeOf(await h.t2d.held(next, { command: 'task.dispatch' }))).toBe('applied');
    });
  },
);

describe.skipIf(url === undefined)(
  'a kept replacement in another business',
  { timeout: 60_000 },
  () => {
    it("dispatches in another business, whatever this business's register names", async () => {
      const template = await aRealWriteOff(s);
      // While the other business's call is out, this business's register names that
      // business's first attempt as written off, and nothing closes it there.
      const seen = await dispatchedAfter(other, ho, async (w) => {
        await s.db.app.withBusiness(s.business, async (tx) => {
          await plantWriteOff(tx, template, { attemptId: w.attemptId, taskId: w.taskId });
        });
      });
      expect(seen).toMatchObject({
        code: 'applied',
        after: { envelope: seen.before.envelope, cap: seen.before.cap, mark: { marked: true } },
      });
    });
  },
);
