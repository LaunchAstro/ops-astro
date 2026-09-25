// SPDX-License-Identifier: AGPL-3.0-only
//
// Thermo NB1 at e84add2, through the command entry.
//
// `withinBounds` reads the cap through the one cap-sum source decide shares
// and tests the room with the one `exceeds`. Its edges: with 2 units left, a
// ceiling of 3 (one past the room) is refused `SUCCESSOR_OUT_OF_BOUNDS`, as is
// a successor in another currency than the cap's; a ceiling of exactly 2 fits.
// Each refusal names what it read, and nothing moves.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { handbackFootprint, retainedCodes, successorBody } from './handback-footprint.ts';
import {
  appliedDetail,
  asAgent,
  handbackBody,
  liveWork,
  openSchedules,
  type Schedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/successor-bounds-edge: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

describe.skipIf(serverUrl === undefined)('NB1: a successor at the edge of the cap', () => {
  let s: Schedules;

  beforeAll(async () => {
    s = await openSchedules('nb1edge', 10);
  }, 90_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it('refuses one past the room and another currency, and accepts exactly the room', async () => {
    const { picked } = await liveWork(s, 'the work handed back', 8);
    const credential = String(picked['credential']);
    const before = await handbackFootprint(s, picked['leaseId']);

    const past = await asAgent(s, handbackBody(picked, successorBody(3)), credential);
    expect(past).toStrictEqual({
      refused: true,
      code: 'SUCCESSOR_OUT_OF_BOUNDS',
      names: [],
      fixes: [
        'the cap behind this envelope has 8 of 10 committed, so a successor asking 3 does not fit its remaining 2',
        'Propose a successor within the cap, or raise the cap through its own authorised decision.',
      ],
    });

    const other = await asAgent(
      s,
      handbackBody(picked, { ...successorBody(1), currency: 'USD' }),
      credential,
    );
    expect(other).toStrictEqual({
      refused: true,
      code: 'SUCCESSOR_OUT_OF_BOUNDS',
      names: [],
      fixes: [
        "this task's envelope is in AUD and the successor is in USD",
        'Propose the successor in the currency the envelope holds.',
      ],
    });

    expect(await retainedCodes(s, picked['leaseId'])).toStrictEqual([]);
    expect(await handbackFootprint(s, picked['leaseId'])).toStrictEqual(before);

    const accepted = appliedDetail(
      await asAgent(s, handbackBody(picked, successorBody(2)), credential),
      'task.handback with a successor of exactly the room',
    );
    expect(accepted['successorGateId']).toEqual(expect.any(String));
  }, 60_000);
});
