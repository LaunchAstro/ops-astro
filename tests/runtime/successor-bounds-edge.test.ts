// SPDX-License-Identifier: AGPL-3.0-only
//
// Thermo NB1 at e84add2, through the command entry.
//
// `withinBounds` reads the cap through the one cap-sum source decide shares
// and tests the room with the one `exceeds`. Its edges: with 2 units left, a
// ceiling of 3 (one past the room) is refused `SUCCESSOR_OUT_OF_BOUNDS`, as is
// a successor in another currency than the cap's; a ceiling of exactly 2 fits.
// Each refusal names what it read, and nothing moves.
//
// A successor whose purpose a proposal cannot hold ("Draft reply", outside
// `proposal_versions_purpose_shape`) is refused `FIELD_VALUE_INVALID` naming
// `successor.purpose`, with its refusal audited, rather than reaching the
// constraint and answering `SERVICE_UNAVAILABLE`. The lease, the hold and the
// reports stay as they were, and the same lease then hands back.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { handbackFootprint, retainedCodes, successorBody } from './handback-footprint.ts';
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
    'runtime/successor-bounds-edge: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

// Opened by the block below, which runs only with a database.
let s: Schedules;

describe.skipIf(serverUrl === undefined)('a successor at the edge of the cap', () => {
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

describe.skipIf(serverUrl === undefined)('a successor whose purpose a proposal cannot hold', () => {
  let shaped: Schedules;

  beforeAll(async () => {
    shaped = await openSchedules('purposeshape', 10);
  }, 90_000);

  afterAll(async () => {
    await shaped?.db.drop();
  });

  it('refuses the purpose by name, audits the refusal and leaves the lease to hand back', async () => {
    const { picked } = await liveWork(shaped, 'the work handed back', 4);
    const credential = String(picked['credential']);
    const before = await handbackFootprint(shaped, picked['leaseId']);

    const body = handbackBody(picked, { ...successorBody(1), purpose: 'Draft reply' });
    const answer = await asAgent(shaped, body, credential);
    expect(answer).toMatchObject({
      refused: true,
      code: 'FIELD_VALUE_INVALID',
      names: ['successor.purpose'],
    });

    const audited = await rows<{ readonly outcome: string; readonly code: string | null }>(
      shaped,
      `select outcome, refusal_code as code from public.audit_events
        where business_id = $1 and operation_id = $2`,
      [shaped.business, body['operationId']],
    );
    expect(audited.map((row) => [row.outcome, row.code])).toStrictEqual([
      ['refused', 'FIELD_VALUE_INVALID'],
    ]);
    expect(await retainedCodes(shaped, picked['leaseId'])).toStrictEqual([]);
    expect(await handbackFootprint(shaped, picked['leaseId'])).toStrictEqual(before);

    const accepted = appliedDetail(
      await asAgent(shaped, handbackBody(picked, successorBody(1)), credential),
      'task.handback with a well-formed successor purpose',
    );
    expect(accepted['successorGateId']).toEqual(expect.any(String));
  }, 60_000);
});
