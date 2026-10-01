// SPDX-License-Identifier: AGPL-3.0-only
//
// C81: the breach drill's 30-day assessment clock, through the real API: the
// clock starts at awareness, on the database clock, and the operations view
// flags an assessment past due. The world is `c81-breach-drill-world.ts`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import {
  closeDrill,
  DAY_MS,
  harness,
  incident,
  incidentsOf,
  openDrill,
  record,
  view,
} from './c81-breach-drill-world.ts';

if (serverUrl === undefined) {
  console.warn('operations/c81-breach-drill-clock: DATABASE_URL is unset, so nothing below ran.');
}

beforeAll(async () => {
  if (serverUrl !== undefined) await openDrill('c81_drill_clock');
}, 120_000);

afterAll(async () => {
  if (serverUrl !== undefined) await closeDrill();
});

describe.skipIf(serverUrl === undefined)('C81 the breach drill', () => {
  it('C81 breach drill 30-day assessment: the clock starts at awareness, and an assessment left past day 30 is flagged', async () => {
    const late = await record(incident(31));
    const early = await record(incident(29));
    const now = await record(incident(0.01));

    const answer = await view();
    expect(answer.status).toBe(200);
    const byId = new Map(incidentsOf(answer).map((row) => [row.id, row]));
    for (const id of [late, early, now]) {
      const row = byId.get(id);
      expect(row, id).toBeDefined();
      // Day 0 is when it was found, not when it was recorded: 30 days from foundAt.
      expect(Date.parse(row?.assessBy ?? ''), id).toBe(
        Date.parse(row?.foundAt ?? '') + 30 * DAY_MS,
      );
      expect(Date.parse(row?.recordedAt ?? ''), id).toBeGreaterThan(Date.parse(row?.foundAt ?? ''));
    }
    expect(byId.get(late)?.overdue, 'found 31 days ago, still open').toBe(true);
    expect(byId.get(early)?.overdue, 'found 29 days ago').toBe(false);
    expect(byId.get(now)?.overdue, 'found today').toBe(false);

    // A holder of operations:read alone sees the same flag.
    const noah = await view(harness.world.noah.token);
    expect(noah.status).toBe(200);
    expect(incidentsOf(noah).find((row) => row.id === late)?.overdue).toBe(true);
  });
});
