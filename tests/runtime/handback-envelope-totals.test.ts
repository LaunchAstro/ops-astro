// SPDX-License-Identifier: AGPL-3.0-only
//
// The envelope totals a handback answers with are the envelope row's, read
// after the settlement. An ordinary handback releases its hold, so its totals
// are 0 and 0, which is also what an unread row used to be rendered as. A
// marked attempt keeps its full hold as quarantined (R7), so its handback
// answers a held total that only the row can supply (thermo NB5).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  appliedDetail,
  asAgent,
  handbackBody,
  liveWork,
  openSchedules,
  rows,
  type Schedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/handback-envelope-totals: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

describe.skipIf(serverUrl === undefined)('handback envelope totals', () => {
  let s: Schedules;

  beforeAll(async () => {
    s = await openSchedules('nb5env', 100_000);
  }, 90_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it('answers the quarantined hold the envelope row still carries', async () => {
    const { decision, picked } = await liveWork(s, 'handed back with a marked attempt', 1_500);
    // An imported or corrupt observation, applied as the owner would find it.
    await s.db.admin.execute(
      `update public.attempts set observed = true, state = 'quarantined'
        where business_id = $1 and id = $2`,
      [s.business, decision['attemptId']],
    );

    const handed = appliedDetail(
      await asAgent(s, handbackBody(picked), String(picked['credential'])),
      'task.handback of a marked attempt',
    );
    expect(handed['reservationState']).toBe('quarantined');
    expect(handed['envelopeHeldMinor']).toBe(1_500);
    expect(handed['envelopeActualMinor']).toBe(0);

    const envelope = await rows<{ readonly held: string; readonly actual: string }>(
      s,
      `select e.held_minor::text as held, e.actual_minor::text as actual
         from public.task_envelopes e
         join public.reservations r on r.business_id = e.business_id and r.envelope_id = e.id
        where r.business_id = $1 and r.id = $2`,
      [s.business, decision['reservationId']],
    );
    expect(envelope).toEqual([{ held: '1500', actual: '0' }]);
  }, 30_000);
});
