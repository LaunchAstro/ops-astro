// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5, the effect metadata proved on the money paths the positive fixtures
// miss (SEC3BFINAL L4 to L7): each needs the broker's calls, which the
// person's route never makes, so they run on AW-10's fault world. Each path
// is run once, the tables whose rows changed are compared with the record
// kinds its command declares, and the path must write the tables it is about,
// so a fixture that stopped reaching it fails rather than passing empty.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import {
  asAgent,
  asPerson,
  codeOf,
  handbackBody,
  liveWork,
  rows,
} from '../runtime/schedules-harness.ts';
import { pickupOf, spentWhole } from '../runtime/resume-sizing-world.ts';
import {
  callIn,
  dropped,
  noDatabase,
  outcome,
  pass,
  s,
  useFaultWorld,
  world,
} from '../broker/aw-10-world.ts';
import { pathFaults, type EffectPath } from './s0-5-effect-diff.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useFaultWorld('s05money');

type Work = Awaited<ReturnType<typeof liveWork>>;

/** A step whose one call is held unknown: the provider cannot say whether it went out. */
async function heldCall(): Promise<Work> {
  world.provider.lookupMode('unreachable');
  const { work } = await dropped('cut');
  await pass();
  return work;
}

/**
 * The same at a hold of one call's price, the call then settled at the whole
 * of it, as `resume-sizing-world.ts`'s `settledAtWhole` moves it: the replay
 * provider never bills that high. Nothing is left to hold for the step.
 */
async function heldAtWhole(): Promise<Work> {
  world.provider.lookupMode('unreachable');
  const work = await liveWork(s, `s0-5 spent ${randomUUID()}`, 500);
  world.provider.mode('cut');
  const result = await callIn(s, work);
  const cause = 'cause' in result ? result.cause : null;
  const body = {
    ...handbackBody(work.picked),
    outcome: 'dropped',
    report: { summary: 'the provider failed', dropCause: cause },
  };
  await asAgent(s, body, String(work.picked['credential']));
  await pass();
  await s.db.admin.execute(
    `update public.model_calls
        set state = 'settled', observed_minor = reserved_minor, actual_minor = reserved_minor,
            drop_state = null, completed_at = clock_timestamp(), ended_at = clock_timestamp()
      where reservation_id = $1`,
    [work.decision['reservationId']],
  );
  return work;
}

/** The run's three asks, raised already, as `resume-sizing-stop.test.ts` raises them. */
async function asksSpent(work: Work): Promise<void> {
  for (const at of [1, 2, 3]) {
    // eslint-disable-next-line no-await-in-loop
    await rows(
      s,
      `insert into public.budget_asks
         (business_id, id, run_id, reservation_id, lease_id, decision_id, ask_number, kind,
          ceiling_minor, spent_minor, currency)
       select r.business_id, $2, r.run_id, r.id, $3, d.id, $4, $5, r.held_minor, 0, 'AUD'
         from public.reservations r
         join public.gate_decisions d on d.business_id = r.business_id and d.version_id = r.version_id
        where r.id = $1 and d.decision = 'approve'`,
      [
        work.decision['reservationId'],
        randomUUID(),
        work.picked['leaseId'],
        at,
        at === 3 ? 'consolidated' : 'stop',
      ],
    );
  }
}

const settledOn = (work: Work, extra: Record<string, unknown>) => ({
  operationId: randomUUID(),
  recordId: work.taskId,
  attemptId: work.picked['attemptId'],
  ...extra,
});

const PATHS: readonly EffectPath[] = [
  {
    // L5: a step whose calls spent its whole hold stops at its budget and asks.
    name: 'task.pickup',
    code: 'BUDGET_UNAVAILABLE',
    drives: ['budget_asks'],
    prepare: async () => {
      const work = await spentWhole(`s0-5 pickup ${randomUUID()}`);
      return async () => codeOf(await pickupOf(work));
    },
  },
  {
    // L5: after the consolidated ask the run ends and a person is told.
    name: 'task.pickup',
    code: 'BUDGET_UNAVAILABLE',
    drives: ['alerts'],
    prepare: async () => {
      const work = await spentWhole(`s0-5 last ask ${randomUUID()}`);
      await asksSpent(work);
      return async () => codeOf(await pickupOf(work));
    },
  },
  {
    // L4: the top-up at a spent hold is the step's fresh hold, a new attempt.
    name: 'run.top_up',
    code: 'applied',
    drives: ['attempts'],
    prepare: async () => {
      const work = await spentWhole(`s0-5 top-up ${randomUUID()}`);
      expect(codeOf(await pickupOf(work))).toBe('BUDGET_UNAVAILABLE');
      const [ask] = await rows<{ id: string; run_id: string }>(
        s,
        'select id, run_id from public.budget_asks where reservation_id = $1',
        [work.decision['reservationId']],
      );
      const body = {
        command: 'run.top_up',
        operationId: randomUUID(),
        recordId: work.taskId,
        runId: ask?.run_id,
        askId: ask?.id,
        amountMinor: 300,
        currency: 'AUD',
      };
      return async () => codeOf(await asPerson(s, body));
    },
  },
  {
    // L6: the step's held call takes the person's outcome.
    name: 'budget.record_outcome',
    code: 'applied',
    drives: ['model_calls'],
    prepare: async () => {
      const work = await heldCall();
      return async () => codeOf(await outcome(s, work, 'happened'));
    },
  },
  {
    // L6: nothing happened, but the step's calls spent its whole hold: the run stops and asks.
    name: 'budget.record_outcome',
    code: 'applied',
    drives: ['budget_asks', 'planned_runs'],
    prepare: async () => {
      const work = await heldAtWhole();
      return async () => codeOf(await outcome(s, work, 'nothing_happened'));
    },
  },
  {
    // L7: the step's held call records the write-off and who made it.
    name: 'budget.write_off',
    code: 'applied',
    drives: ['model_calls'],
    prepare: async () => {
      const work = await heldCall();
      const body = settledOn(work, {
        command: 'budget.write_off',
        amountMinor: 0,
        reason: 'the provider confirmed by phone',
      });
      return async () => codeOf(await asPerson(s, body));
    },
  },
];

it.each(PATHS)(
  'S0-5 gate coverage (money paths): $name, writing $drives, declares what it writes',
  async (path) => {
    expect(await pathFaults(s.db.admin, path)).toStrictEqual([]);
  },
  120_000,
);
