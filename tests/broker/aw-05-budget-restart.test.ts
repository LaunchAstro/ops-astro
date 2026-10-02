// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-05's answers, part 2: restart across the budget stop. A restart replays
// the recorded transitions; at each of the four points around the stop it
// revives nothing, releases nothing twice and loses no approval, and the
// lease the stop ended stays released.

import { expect, it as vitestIt } from 'vitest';
import {
  endAtBudgetStop,
  replayRecordedTransitions,
  topUpAtBudgetStop,
} from '../../packages/core-runtime/src/index.ts';
import type { Member } from '../commands/fixture.ts';
import { pickup } from '../runtime/schedules-harness.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import {
  as,
  moneyOf,
  one,
  people,
  setThreshold,
  stopped,
  usePeople,
} from './budget-answers-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('aw05restart');
usePeople();

const restart = async () =>
  await s.db.app.withBusiness(s.business, async (tx) => await replayRecordedTransitions(tx));

const approve = async (member: Member, runId: string) =>
  await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await topUpAtBudgetStop(tx, { ...as(member, runId), amountMinor: 300, currency: 'AUD' }),
  );

const end = async (member: Member, runId: string) =>
  await s.db.app.withBusiness(
    s.business,
    async (tx) => await endAtBudgetStop(tx, as(member, runId)),
  );

it('AW-05 restart across the stop: waiting, the hold kept and the lease released', async () => {
  const waiting = await stopped('aw05 restart waiting');
  const waited = await moneyOf(waiting.runId);
  await restart();
  expect(await moneyOf(waiting.runId)).toEqual(waited);
  const { state } = await one<{ state: string }>(`select state from public.leases where id = $1`, [
    waiting.work.picked['leaseId'],
  ]);
  expect(state).toBe('released');
});

it('AW-05 restart across the stop: one of two approvals kept, then topped up and picked up', async () => {
  await setThreshold(1);
  const pending = await stopped('aw05 restart pending');
  expect((await approve(people.approver, pending.runId)).ok).toBe(true);
  const approved = await moneyOf(pending.runId);
  await restart();
  expect(await moneyOf(pending.runId)).toEqual(approved);
  expect(await approve(people.second, pending.runId)).toMatchObject({
    ok: true,
    value: { state: 'applied' },
  });

  // Topped up, not yet picked up: a restart may classify the old hold, and
  // the pickup still holds the raised ceiling, counted once.
  const topped = await moneyOf(pending.runId);
  await restart();
  await pickup(s, pending.work.decision['reservationId']);
  expect(await moneyOf(pending.runId)).toMatchObject({
    run: 'claimed',
    held: topped.held,
    cap_committed: topped.cap_committed,
  });
});

it('AW-05 restart across the stop: ended, nothing revived or released twice', async () => {
  const ended = await stopped('aw05 restart ended');
  expect((await end(people.second, ended.runId)).ok).toBe(true);
  const over = await moneyOf(ended.runId);
  await restart();
  expect(await moneyOf(ended.runId)).toEqual(over);
});
