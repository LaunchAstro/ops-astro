// SPDX-License-Identifier: AGPL-3.0-only
//
// W05: two distinct reservations competing for the last room under one cap.
//
// `gate.test.ts` refuses at the cap sequentially and races two approvals of
// the *same* version, which the gate's own decision row settles. Neither shows
// two *different* approvals, on two tasks with two envelopes, each of which
// fits alone and which do not fit together, arriving at the cap at once. That
// is the ledger's "competing permitted reservations cannot exceed
// envelope/cap", and a reserve that read the committed total outside the cap
// lock would let both through.
//
// Both approvals go through `task.decide` on connections of their own. A third
// connection holds the cap row. The first approval is seen parked on it, the
// second is seen parked behind the first on the business decision-chain lock
// `task.decide` takes before the cap, and then the holder lets go.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import type { CommandResult } from '../../packages/core-records/src/commands/register-store.ts';
import {
  approve,
  approveBody,
  asPerson,
  awaitParked,
  capCommitted,
  codeOf,
  createTask,
  holdRows,
  openSchedules,
  propose,
  racer,
  reasonOf,
  rows,
  scalar,
  settle,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/schedules-w05: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

/** The fixture's synthetic cap, never a production budget. */
const CAP = 10_000;
/** Committed before the race, leaving 4,000 of room. */
const PREFILL = 6_000;
/** Each competitor fits the room alone; two do not. */
const EACH = 3_000;

describe.skipIf(serverUrl === undefined)('W05: competing distinct reservations at the cap', () => {
  let s: Schedules;

  beforeAll(async () => {
    s = await openSchedules('w05', CAP);
  }, 90_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  async function reservationsFor(proposal: Detail): Promise<number> {
    return await scalar(
      s,
      `select count(*)::text as n from public.reservations where business_id = $1 and version_id = $2`,
      [s.business, proposal['versionId']],
    );
  }

  async function gateState(proposal: Detail): Promise<string> {
    const found = await rows<{ readonly state: string }>(
      s,
      `select state from public.gates where business_id = $1 and id = $2`,
      [s.business, proposal['gateId']],
    );
    return found[0]?.state ?? 'missing';
  }

  it('lets exactly one through, refuses the other as exhausted, and keeps the totals exact', async () => {
    const prefillTask = await createTask(s, 'the work already committed');
    await approve(s, await propose(s, prefillTask, { maximumMinor: PREFILL }));
    expect(await capCommitted(s)).toBe(PREFILL);

    const left = await propose(s, await createTask(s, 'first competitor'), { maximumMinor: EACH });
    const rightTask = await createTask(s, 'second competitor');
    const right = await propose(s, rightTask, { maximumMinor: EACH });

    const leftDb = racer(s);
    const rightDb = racer(s);
    const holder = await holdRows(s, 'budget_caps', [s.capId]);
    let outcomes: readonly PromiseSettledResult<CommandResult>[] = [];
    try {
      const first = asPerson(s, approveBody(left), leftDb);
      await awaitParked(s, 'budget_caps', 1);
      const second = asPerson(s, approveBody(right), rightDb);
      // Parked behind the first on the business decision chain (`decide.ts`,
      // R10), which it cannot pass until the first commits.
      await awaitParked(s, 'advisory', 1);
      await holder.release();
      outcomes = await settle([first, second]);
    } finally {
      await holder.release().catch(() => undefined);
      await leftDb.close();
      await rightDb.close();
    }

    for (const outcome of outcomes) expect(outcome.status, reasonOf(outcome)).toBe('fulfilled');
    const codes = outcomes.map((outcome) =>
      outcome.status === 'fulfilled' ? codeOf(outcome.value) : 'rejected',
    );
    // The first to the cap wins; the one queued behind it is told the cap, not
    // the envelope, has no room.
    expect(codes).toStrictEqual(['applied', 'BUDGET_EXHAUSTED']);

    expect(await reservationsFor(left)).toBe(1);
    expect(await reservationsFor(right)).toBe(0);
    expect(await gateState(left)).toBe('approved');
    expect(await gateState(right)).toBe('pending');
    // Exact, not merely under the cap: one prefill and one competitor.
    expect(await capCommitted(s)).toBe(PREFILL + EACH);
    expect(
      await scalar(
        s,
        `select coalesce(sum(held_minor), 0)::text as n from public.reservations
          where business_id = $1 and state = 'held'`,
        [s.business],
      ),
    ).toBe(PREFILL + EACH);
    // The loser left no envelope behind: its refusal rolled back with it.
    expect(
      await scalar(
        s,
        `select count(*)::text as n from public.task_envelopes where business_id = $1 and task_id = $2`,
        [s.business, rightTask],
      ),
    ).toBe(0);
  }, 30_000);
});
