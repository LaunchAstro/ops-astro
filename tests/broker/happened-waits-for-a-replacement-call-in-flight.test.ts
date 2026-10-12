// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's `happened` stops a replacement the pass reserved for the step,
// but only one that has sent nothing. A replacement whose worker has a model
// call out at the provider, before its own `task.dispatch`, owes that call's
// cost: releasing its hold would leave the late answer charged to nothing.
// So `happened` refuses, nothing moves, and the call settles on its own hold.

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { codeOf, pickup } from '../runtime/schedules-harness.ts';
import { openBilling, t3d1Harness } from '../runtime/t3d1-harness.ts';
import type { Work } from '../runtime/t2d-harness.ts';
import {
  call,
  gated,
  LOCAL,
  noDatabase,
  s,
  stepOf,
  useBrokerWorld,
  withRoutes,
} from './broker-world.ts';

const h = t3d1Harness(() => s);

/** An unknown step proved absent, and its replacement picked up by a fresh worker. */
const replaced = async (): Promise<{ readonly original: Work; readonly next: Work }> => {
  const original = await h.unknownStep({ applied: false, room: true });
  await h.reconcile();
  const picked = await pickup(s, await h.replacement(original));
  const next = {
    ...original,
    picked,
    credential: String(picked['credential']),
    attemptId: String(picked['attemptId']),
  };
  return { original, next };
};

const callStates = async (next: Work): Promise<readonly string[]> =>
  (
    await s.db.admin.execute<{ state: string }>(
      `select state from public.model_calls where lease_id = $1`,
      [next.picked['leaseId']],
    )
  ).map((one) => one.state);

describe.skipIf(noDatabase)('happened and a replacement call in flight', () => {
  useBrokerWorld('happenedinflight');

  beforeAll(async () => {
    await openBilling(s);
  });

  it(
    'happened refuses while the replacement has a model call at the provider, and the call settles on its hold',
    { timeout: 120_000 },
    async () => {
      const { original, next } = await replaced();
      await stepOf(next);
      // The local route: the work's fields keep it off cloud models.
      const provider = gated(withRoutes([LOCAL]));
      const answer = call(next, {}, provider.broker);
      // The call is at the provider: sent, its answer held by the gate.
      await vi.waitFor(async () => {
        expect(await callStates(next)).toStrictEqual(['dispatched']);
      });
      const before = await h.envelope(original);

      expect(codeOf(await h.outcome(original, 'happened', randomUUID()))).toBe(
        'TRANSITION_NOT_PERMITTED',
      );
      expect(await h.envelope(original)).toStrictEqual(before);

      provider.open();
      expect((await answer).ok).toBe(true);
      expect(await callStates(next)).toStrictEqual(['settled']);
    },
  );
});
