// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's write-off charges a hold whose call was sent and never answered:
// the charge is final. A top-up answer on that closed hold, whichever writer
// made it, never makes the written-off call a counted one: when the call's
// worker settles it late, nothing is given back to an envelope that never
// carried it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  codeOf,
  openSchedules,
  pickup,
  type Schedules,
} from './schedules-harness.ts';
import { writeOffBody } from './t3c-harness.ts';
import {
  askOf,
  callState,
  dispatchedCall,
  envelopeOf,
  roomyWork,
  spend,
  stampBefore,
  stopWorker,
  sweep,
} from './version-room-world.ts';
import { answerLate, attemptOf, counted, priced } from './written-off-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/written-off-call-settled-late-gives-nothing-back: DATABASE_URL is unset, so nothing below ran.',
  );
}

let s: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('written_off_late', 1_000_000);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'manage');
    await grantTo(tx, s.decider, 'decide', undefined, false, 'billing');
    await grantTo(tx, s.decider, 'decide', undefined, false, 'gate');
    await installBusinessSettings(tx);
  });
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

describe.skipIf(serverUrl === undefined)('a written-off call that settles late', () => {
  it('gives nothing back when a top-up answer on its closed hold reads it as counted', async () => {
    // The first hold settles 300 and dispatches c2 at 200; the worker goes,
    // the sweep holds c2 unknown, and a person writes the hold off at 0.
    const { work, first } = await roomyWork(s);
    await spend(s, first, 300);
    const c2 = await dispatchedCall(s, first, 200);
    await stopWorker(s, work.picked);
    await sweep(s);
    appliedDetail(
      await asPerson(
        s,
        writeOffBody({ taskId: work.taskId, attemptId: await attemptOf(s, first) }, 0),
      ),
      'budget.write_off',
    );
    // A stop raised on the written-off hold, for room.
    const second = await pickup(s, first);
    await spend(s, second['reservationId'], 200);
    await stopWorker(s, second);
    await stampBefore(s, first, second['reservationId']);
    const stopped = await asAgent(s, {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId: first,
      leaseSeconds: 600,
    });
    expect(codeOf(stopped)).toBe('BUDGET_UNAVAILABLE');
    // A top-up answer recorded on the closed hold by a writer other than the
    // runtime's refusal-guarded one: the answer row alone, as found closed.
    const { runId, askId } = await askOf(s, first);
    await s.db.admin.execute(
      `insert into public.budget_answers
         (business_id, id, ask_id, run_id, kind, amount_minor, currency, first_person_id, hold_state)
       values ($1, $2, $3, $4, 'top_up', 100, 'AUD', $5, 'actual')`,
      [s.business, randomUUID(), askId, runId, s.decider.personId],
    );
    const before = await envelopeOf(s, work);

    await answerLate(s, work.picked, c2, priced(150));

    expect({ call: await callState(s, c2), envelope: await envelopeOf(s, work) }).toEqual({
      call: 'settled',
      envelope: before,
    });
    expect(await counted(s, first)).toBe(true);
  });
});
