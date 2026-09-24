// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol 6 RUNTIME-2 at 158d6de, through the command entry.
//
// A successor's ceiling is bounded by the cap's remaining room, and a cap
// above 2^53 is compared exactly. With 2 units left, a ceiling of 4 is refused
// `SUCCESSOR_OUT_OF_BOUNDS` before anything is written; a ceiling of 2 fits.
// Every total here is read from SQL as text.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { handbackFootprint, retainedCodes, successorBody } from './handback-footprint.ts';
import {
  appliedDetail,
  approve,
  asAgent,
  codeOf,
  createTask,
  freshPurpose,
  handbackBody,
  liveWork,
  openSchedules,
  propose,
  rows,
  type Schedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/successor-bounds-exact: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

describe.skipIf(serverUrl === undefined)('RUNTIME-2: a successor is bounded exactly', () => {
  /** 2^54 + 3: a valid bigint that a JavaScript number rounds to 2^54 + 4. */
  const LIMIT = '18014398509481987';
  let s: Schedules;

  beforeAll(async () => {
    s = await openSchedules('s6suc', 1);
    // Set as text, so the parameter never passes through a number.
    await s.db.admin.execute(
      `update public.budget_caps set limit_minor = $3::text::bigint
        where business_id = $1 and id = $2`,
      [s.business, s.capId, LIMIT],
    );
  }, 90_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  async function committed(): Promise<string> {
    const found = await rows<{ readonly n: string }>(
      s,
      `select coalesce(sum(held_minor + actual_minor), 0)::text as n
         from public.task_envelopes where business_id = $1 and cap_id = $2`,
      [s.business, s.capId],
    );
    return found[0]?.n ?? '';
  }

  it('refuses a ceiling of 4 with 2 left, and accepts a ceiling of 2', async () => {
    // Two of the largest safe holds and the live work's 3: 2^54 + 1 committed.
    for (const title of ['the first large hold', 'the second large hold']) {
      // Sequential: each approval reads the total the previous one committed.
      // eslint-disable-next-line no-await-in-loop
      const taskId = await createTask(s, title);
      // eslint-disable-next-line no-await-in-loop
      const proposal = await propose(s, taskId, {
        maximumMinor: Number.MAX_SAFE_INTEGER,
        purpose: freshPurpose(),
      });
      // eslint-disable-next-line no-await-in-loop
      await approve(s, proposal);
    }
    const { picked } = await liveWork(s, 'the work handed back', 3);
    expect(await committed()).toBe('18014398509481985');

    const before = await handbackFootprint(s, picked['leaseId']);
    const refused = await asAgent(
      s,
      handbackBody(picked, successorBody(4)),
      String(picked['credential']),
    );
    expect(codeOf(refused)).toBe('SUCCESSOR_OUT_OF_BOUNDS');
    expect(await retainedCodes(s, picked['leaseId'])).toStrictEqual([]);
    expect(await handbackFootprint(s, picked['leaseId'])).toStrictEqual(before);
    expect(await committed()).toBe('18014398509481985');

    const accepted = appliedDetail(
      await asAgent(s, handbackBody(picked, successorBody(2)), String(picked['credential'])),
      'task.handback with an in-bounds successor',
    );
    expect(accepted['successorGateId']).toEqual(expect.any(String));
    const gate = await rows<{ readonly state: string }>(
      s,
      `select state from public.gates where business_id = $1 and id = $2`,
      [s.business, accepted['successorGateId']],
    );
    expect(gate[0]?.state).toBe('pending');
  }, 60_000);
});
