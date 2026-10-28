// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's write-off charges a hold whose call was sent and never answered:
// the charge is final, and at 0 the step's effect stays unknown, so a pickup
// of the hold is refused (#2277). A top-up answer on that closed hold,
// whichever writer made it, never makes the written-off call a counted one:
// when the call's worker settles it late, nothing is given back to an
// envelope that never carried it.

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
  type Schedules,
  type Work,
} from './schedules-harness.ts';
import { writeOffBody } from './t3c-harness.ts';
import {
  askOf,
  callState,
  dispatchedCall,
  envelopeOf,
  holdsOf,
  moneyOf,
  roomyWork,
  spend,
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

/**
 * An ask and a top-up answer recorded on the closed hold by a writer other
 * than the runtime's refusal-guarded one: the rows alone, as found closed.
 */
async function topUpAnsweredOutOfBand(work: Work, first: unknown): Promise<void> {
  const { runId } = await askOf(s, first);
  const askId = randomUUID();
  await s.db.admin.execute(
    `insert into public.budget_asks
       (business_id, id, run_id, reservation_id, lease_id, decision_id, ask_number, kind,
        ceiling_minor, spent_minor, currency)
     select r.business_id, $2, r.run_id, r.id, $3,
            (select d.id from public.gate_decisions d
              where d.business_id = r.business_id and d.version_id = r.version_id
                and d.decision = 'approve' order by d.seq desc limit 1),
            1, 'stop', 500, 300, 'AUD'
       from public.reservations r where r.business_id = $1 and r.id = $4`,
    [s.business, askId, work.picked['leaseId'], first],
  );
  await s.db.admin.execute(
    `insert into public.budget_answers
       (business_id, id, ask_id, run_id, kind, amount_minor, currency, first_person_id, hold_state)
     values ($1, $2, $3, $4, 'top_up', 100, 'AUD', $5, 'actual')`,
    [s.business, randomUUID(), askId, runId, s.decider.personId],
  );
}

describe.skipIf(serverUrl === undefined)('a written-off call that settles late', () => {
  it('gives nothing back when a top-up answer on its closed hold reads it as counted', async () => {
    // The first hold settles 300 and dispatches c2 at 200; the worker goes,
    // the sweep holds c2 unknown, and a person writes the hold off at 0.
    const { work, versionId, first } = await roomyWork(s);
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
    // #2277: the step's effect is unknown, so a pickup of the written-off hold
    // is refused, with no replacement and no money moved. The stop for room
    // the runtime raised on the hold through that replacement no longer
    // arises.
    const unmoved = await moneyOf(s, work, versionId);
    const picked = await asAgent(s, {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId: first,
      leaseSeconds: 600,
    });
    expect({
      picked: codeOf(picked),
      held: (await holdsOf(s, versionId)).filter((hold) => hold.state === 'held'),
      money: await moneyOf(s, work, versionId),
    }).toEqual({ picked: 'RESERVATION_NOT_CLAIMABLE', held: [], money: unmoved });
    await topUpAnsweredOutOfBand(work, first);
    const before = await envelopeOf(s, work);

    await answerLate(s, work.picked, c2, priced(150));

    expect({ call: await callState(s, c2), envelope: await envelopeOf(s, work) }).toEqual({
      call: 'settled',
      envelope: before,
    });
    expect(await counted(s, first)).toBe(true);
  });
});
