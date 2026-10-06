// SPDX-License-Identifier: AGPL-3.0-only
//
// C59 (SEC-B1 M4): a reset's provider step is claimed one row at a time, so a
// pass slower than one claim never lets a second settle send a row the first
// is still to send; and a fault answered late, after another settle stamped
// the row done, is never stamped onto it.
//
// The claim is the database's clock, so these cases wait in real time: a
// claim of one or two seconds against a provider that answers slower.

import { describe, expect, it } from 'vitest';
import { settleFactorResets, type LoginProvider } from '../../packages/core-commands/src/index.ts';
import { serverUrl } from '../acceptance/world.ts';
import type { Member } from '../commands/fixture.ts';
import { harness, useEndAccessWorld } from './c58-end-access-world.ts';
import { factorFake, owedReset, resetState } from './c59-factor-reset-world.ts';

useEndAccessWorld();

const settle = async (provider: LoginProvider, only: readonly string[], claimSeconds: number) =>
  await settleFactorResets(harness.world.db.app, harness.world.alpha, provider, {
    claimSeconds,
    only,
  });

const wait = async (ms: number): Promise<void> => {
  await new Promise<void>((done) => {
    setTimeout(done, ms);
  });
};

const doneAt = async (person: Member): Promise<string | null> =>
  (
    await harness.world.db.app.withBusiness(
      harness.world.alpha,
      async (tx) =>
        await tx.query<{ readonly at: string | null }>(
          'select done_at::text as at from public.factor_resets where person_id = $1',
          [person.personId],
        ),
    )
  )[0]?.at ?? null;

async function slowPassSendsEachOnce(): Promise<void> {
  const first = await owedReset('abe');
  const second = await owedReset('bo');
  const only = [first.id, second.id];
  // Each send is inside the 2-second claim; the two together are not.
  const { calls, provider } = factorFake([], 1400);
  const slow = settle(provider, only, 2);
  await wait(2400);
  await settle(provider, only, 2);
  await slow;
  expect(calls.map((call) => call.factorId).toSorted()).toEqual(
    [first.factorId, second.factorId].toSorted(),
  );
}

async function lateFaultLeavesDone(): Promise<void> {
  const owed = await owedReset('cy');
  const late = factorFake([{ ok: false, fault: 'refused' }], 2500);
  const lapsing = settle(late.provider, [owed.id], 1);
  await wait(1300);
  await settle(factorFake().provider, [owed.id], 1);
  const stamped = await doneAt(owed.person);
  expect(stamped).not.toBeNull();
  await lapsing;
  expect(late.calls).toHaveLength(1);
  expect(await doneAt(owed.person)).toBe(stamped);
  expect((await resetState(owed.person)).resets).toEqual([
    expect.objectContaining({ done: true, fault: null }),
  ]);
}

describe.skipIf(serverUrl === undefined)("C59 a reset step's claim", () => {
  it(
    'C59 claim: a pass of sends slower than one claim does not let a second settle send a row again',
    slowPassSendsEachOnce,
  );
  it(
    'C59 claim: a fault answered after another settle stamped the row done leaves done_at and the fault as they were',
    lateFaultLeavesDone,
  );
});
