// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-08 with AW-01's money: a plan's lease does its work through the broker,
// and the worker hands every plan lease back for review. A call the broker
// settled is spend, recorded on the call alone until the step's hold ends, so
// the hand-back settles the hold at that spend: the envelope and the cap count
// it. Abandoning the hold "at no cost" would hand the spend back to the cap.

import { expect, it as vitestIt } from 'vitest';
import { appliedDetail, asAgent, handbackBody, liveWork } from '../runtime/schedules-harness.ts';
import { reviewedOutput } from '../runtime/aw-08-world.ts';
import { call, noDatabase, s, useBrokerWorld, world } from './broker-world.ts';
import { one } from './budget-answers-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('aw08spend');

interface Hold {
  readonly reservation: string;
  readonly held: string;
  readonly actual: string | null;
  readonly envelope_held: string;
  readonly envelope_actual: string;
}

const holdOf = async (reservationId: unknown): Promise<Hold> =>
  await one<Hold>(
    `select r.state as reservation, r.held_minor::text as held, r.actual_minor::text as actual,
            e.held_minor::text as envelope_held, e.actual_minor::text as envelope_actual
       from public.reservations r
       join public.task_envelopes e on e.business_id = r.business_id and e.id = r.envelope_id
      where r.id = $1`,
    [reservationId],
  );

it("a plan lease's settled model call is counted on hand-back for review", async () => {
  const work = await liveWork(s, 'aw08 review spend', 2_000);
  world.provider.mode('answer');
  const result = await call(work);
  if (!result.ok) throw new Error(`the priced replay call was refused ${result.code}`);
  const { spent } = await one<{ spent: string }>(
    `select actual_minor::text as spent from public.model_calls
      where lease_id = $1 and state = 'settled'`,
    [work.picked['leaseId']],
  );
  expect(Number(spent)).toBeGreaterThan(0);
  const reservationId = work.decision['reservationId'];
  const before = await holdOf(reservationId);
  expect(before.reservation).toBe('held');

  const handed = appliedDetail(
    await asAgent(
      s,
      handbackBody(work.picked, reviewedOutput()),
      String(work.picked['credential']),
    ),
    'task.handback',
  );

  expect(handed['reservationState'], 'the spent hold was abandoned at no cost').toBe('actual');
  expect(await holdOf(reservationId)).toEqual({
    reservation: 'actual',
    held: before.held,
    actual: spent,
    envelope_held: String(Number(before.envelope_held) - Number(before.held)),
    envelope_actual: String(Number(before.envelope_actual) + Number(spent)),
  });
  expect(handed['envelopeActualMinor']).toBe(Number(before.envelope_actual) + Number(spent));
  const { state } = await one<{ state: string }>(
    'select state from public.attempts where reservation_id = $1',
    [reservationId],
  );
  expect(state, 'the finished work reads as abandoned').toBe('handed_back');
});
