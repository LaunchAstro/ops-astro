// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.handback` and a spend figure nobody can honestly supply.
//
// Behavioural note 7 from lane L4-RUNTIME-FIX: `handback` answers
// `ACTUAL_EXPENDITURE_UNSUPPORTED` for any non-null `actualMinor`, so a caller
// passing `0` today starts being refused. This head never dispatches, so
// nothing was spent, and `reservations_actual_only_when_actual` makes carrying
// a number and being `actual` the same fact.
//
// The command refuses it **before** the runtime is reached, which is why these
// cases need no database at all: the guard is a payload guard and sits beside
// the `outcome` and `fence` guards next to it. The alternative was to drop the
// key quietly, and that is the failure D06 exists to stop from the other
// direction -- a caller left believing a figure was recorded when nothing ever
// read it.
//
// This suite moves the database counter by zero, so it is a unit suite and
// must not be named in `tests/db/named-suites.json`, for the same reason
// `runtime-codes.test.ts` is not.

import { describe, expect, it } from 'vitest';
import { handbackLease } from '../../packages/core-records/src/commands/tasks-runtime.ts';
import { isRefused } from '../../packages/core-records/src/commands/outcome.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';

/**
 * A transaction that fails the test if it is touched. The point of the guard
 * is that it answers before the database is reached, and a stub that quietly
 * returned rows would let a regression past.
 */
const untouched = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`handback reached the database at .${String(property)}`);
    },
  },
) as unknown as TenantQuery;

const ordinary = {
  leaseId: '3f1d2f3a-0000-4000-8000-000000000001',
  fence: 1,
  outcome: 'completed',
};

const AGENT = '3f1d2f3a-0000-4000-8000-0000000000a9';

describe('task.handback and actualMinor', () => {
  it.each([0, 1, 2_500, -1])('refuses %i, which is a claim the work ran', async (value) => {
    const outcome = await handbackLease(untouched, { ...ordinary, actualMinor: value }, AGENT);
    expect(isRefused(outcome)).toBe(true);
    if (!isRefused(outcome)) throw new Error('unreachable');
    expect(outcome.refusal.code).toBe('ACTUAL_EXPENDITURE_UNSUPPORTED');
    expect(outcome.refusal.names).toEqual(['actualMinor']);
    // The attempted value goes to the audit event and never to the response.
    expect(outcome.attempted).toEqual({ actualMinor: value });
  });

  it('names the key rather than calling the whole body invalid', async () => {
    const outcome = await handbackLease(untouched, { ...ordinary, actualMinor: 0 }, AGENT);
    if (!isRefused(outcome)) throw new Error('unreachable');
    expect(outcome.refusal.code).not.toBe('COMMAND_BODY_INVALID');
    expect(outcome.refusal.fixes.join(' ')).toContain('actualMinor');
  });

  it('refuses before the outcome and fence guards have anything to say', async () => {
    // A body that is wrong in two ways is told about the one it was refused
    // for. What matters here is only that the database is still untouched.
    const outcome = await handbackLease(
      untouched,
      { ...ordinary, outcome: 'nonsense', actualMinor: 5 },
      AGENT,
    );
    expect(isRefused(outcome)).toBe(true);
  });

  it.each([undefined, null])(
    'lets %s through to the runtime, which is the honest value',
    async (value) => {
      // It reaches the database, which is exactly what the proxy reports: the
      // guard did not fire. Anything else here would be testing L4's handback.
      await expect(
        handbackLease(
          untouched,
          { ...ordinary, ...(value === undefined ? {} : { actualMinor: value }) },
          AGENT,
        ),
      ).rejects.toThrow(/reached the database/u);
    },
  );
});
