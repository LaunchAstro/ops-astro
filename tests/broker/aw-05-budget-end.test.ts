// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-05's answers, part 2: the one-click end, and what no one else may do.
// At the budget stop a person holding `gate:decide` ends the work with one
// click and no confirmation (U7): the run ends, the unspent hold is released,
// the spend to date stays counted, and the task is parked for a person, never
// closed or deleted. An agent answers nothing. The wait is left only by an
// answer row, and an answer reaches only the caller's own business and the
// tasks their grant covers.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import {
  endAtBudgetStop,
  topUpAtBudgetStop,
  type BudgetAnswerRequest,
} from '../../packages/core-runtime/src/index.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import {
  appliedDetail,
  asPerson,
  seedSchedules,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import {
  as,
  failingAt,
  moneyOf,
  one,
  people,
  setThreshold,
  stopped,
  UNDER_ONE_CALL,
  usePeople,
} from './budget-answers-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('aw05end');
usePeople();

const end = async (request: BudgetAnswerRequest, business: string = s.business) =>
  await s.db.app.withBusiness(business, async (tx) => await endAtBudgetStop(tx, request));

const topUp = async (request: BudgetAnswerRequest, business: string = s.business) =>
  await s.db.app.withBusiness(
    business,
    async (tx) => await topUpAtBudgetStop(tx, { ...request, amountMinor: 100, currency: 'AUD' }),
  );

const codeOf = (result: { ok: boolean; refusal?: { code: string } }) =>
  result.ok ? 'applied' : result.refusal?.code;

/** The task's whole row: parked means untouched, never closed or deleted. */
const taskOf = async (taskId: string) =>
  await one<{ row: Record<string, unknown> }>(
    `select to_jsonb(r) as row from public.records r where id = $1`,
    [taskId],
  );

it('AW-05 one click ends the work at the budget stop and parks the task', async () => {
  await setThreshold(500);
  const { work, runId } = await stopped('aw05 one click');
  const before = await moneyOf(runId);
  const task = await taskOf(work.taskId);

  // One call, no confirmation: the request carries nothing but who and which run.
  const ended = await end(as(people.second, runId));
  expect(ended).toMatchObject({
    ok: true,
    value: { releasedMinor: UNDER_ONE_CALL, spentMinor: 0 },
  });
  expect(await moneyOf(runId)).toMatchObject({
    run: 'cancelled',
    reservation: 'abandoned',
    envelope_held: String(Number(before.envelope_held) - UNDER_ONE_CALL),
    envelope_actual: before.envelope_actual,
    cap_committed: String(Number(before.cap_committed) - UNDER_ONE_CALL),
    answers: 1,
  });
  const { classified_cause: cause } = await one<{ classified_cause: string }>(
    `select classified_cause from public.reservations where run_id = $1`,
    [runId],
  );
  expect(cause).toBe('budget_stop_ended');
  // Parked for a person: the task is untouched, never closed or deleted.
  expect(await taskOf(work.taskId)).toEqual(task);

  // The response is lost and the click is sent again: refused, nothing moves.
  const after = await moneyOf(runId);
  expect(codeOf(await end(as(people.second, runId)))).toBe('TRANSITION_NOT_PERMITTED');
  expect(codeOf(await topUp(as(people.approver, runId)))).toBe('TRANSITION_NOT_PERMITTED');
  expect(await moneyOf(runId)).toEqual(after);
});

it('AW-05 ending needs gate:decide, and a failed end applies nothing', async () => {
  const { runId } = await stopped('aw05 end refused');
  const before = await moneyOf(runId);
  // `third` holds billing:decide only; `bare` holds neither.
  expect(codeOf(await end(as(people.third, runId)))).toBe('SCOPE_NOT_GRANTED');
  expect(codeOf(await end(as(people.bare, runId)))).toBe('SCOPE_NOT_GRANTED');
  expect(await moneyOf(runId)).toEqual(before);

  for (const [table, event] of [
    ['budget_answers', 'insert'],
    ['reservations', 'update'],
    ['task_envelopes', 'update'],
    ['planned_runs', 'update'],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop
    const crashed = await failingAt(table, event, () => end(as(people.second, runId)));
    expect(String(crashed)).toContain('planted crash');
    // eslint-disable-next-line no-await-in-loop
    expect(await moneyOf(runId)).toEqual(before);
  }
  expect((await end(as(people.second, runId))).ok).toBe(true);
});

it('AW-05 an agent answers nothing', async () => {
  const { runId } = await stopped('aw05 agent refused');
  const before = await moneyOf(runId);
  const agent: BudgetAnswerRequest = {
    runId,
    caller: { kind: 'agent', actorId: s.agentActorId },
    subjects: [{ kind: 'actor', id: s.agentActorId }],
  };
  expect(codeOf(await topUp(agent))).toBe('DELEGATION_EXCLUDES_DECISION');
  expect(codeOf(await end(agent))).toBe('DELEGATION_EXCLUDES_DECISION');
  expect(await moneyOf(runId)).toEqual(before);
});

it('AW-05 the wait is left only by an answer', async () => {
  const { runId } = await stopped('aw05 only an answer');
  for (const state of ['planned', 'cancelled', 'handed_back', 'claimed']) {
    // eslint-disable-next-line no-await-in-loop
    await expect(
      s.db.app.withBusiness(
        s.business,
        async (tx) =>
          await tx.query(`update public.planned_runs set state = $2 where id = $1`, [runId, state]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  }
  // An answer row for another run does not open this one.
  const other = await stopped('aw05 only an answer, the other run');
  expect((await end(as(people.second, other.runId))).ok).toBe(true);
  await expect(
    s.db.app.withBusiness(
      s.business,
      async (tx) =>
        await tx.query(`update public.planned_runs set state = 'cancelled' where id = $1`, [runId]),
    ),
  ).rejects.toMatchObject({ code: '23514' });
  // Answers and approvals are append-only.
  for (const table of ['budget_answers', 'budget_approvals']) {
    // eslint-disable-next-line no-await-in-loop
    await expect(
      s.db.app.withBusiness(
        s.business,
        async (tx) =>
          await tx.query(`delete from public.${table} where run_id = $1`, [other.runId]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  }
  expect((await moneyOf(runId)).run).toBe('waiting_budget');
});

it('AW-05 a cancelled lineage takes no top-up, and one click still ends the run', async () => {
  const { work, runId } = await stopped('aw05 lineage cancelled');
  const { lineage_id: lineageId } = await one<{ lineage_id: string }>(
    `select lineage_id from public.planned_runs where id = $1`,
    [runId],
  );
  const cancelled = await asPerson(s, {
    command: 'task.cancel',
    operationId: randomUUID(),
    recordId: work.taskId,
    lineageId,
    reason: 'the work is no longer wanted',
  });
  appliedDetail(cancelled, 'task.cancel');
  const before = await moneyOf(runId);
  expect(before).toMatchObject({ run: 'waiting_budget', reservation: 'abandoned' });

  expect(codeOf(await topUp(as(people.approver, runId)))).toBe('LINEAGE_TERMINAL');
  expect(await moneyOf(runId)).toEqual(before);
  // Nothing is left held, so ending releases nothing and still ends the run.
  expect(await end(as(people.second, runId))).toMatchObject({
    ok: true,
    value: { releasedMinor: 0 },
  });
  expect(await moneyOf(runId)).toMatchObject({
    run: 'cancelled',
    envelope_held: before.envelope_held,
    cap_committed: before.cap_committed,
  });
});

/** Another business on the same installation, whose decider holds both answers there. */
async function bravoHolding(): Promise<Schedules> {
  const bravo = await seedSchedules(s.db, 'aw05answersbravo', 1_000_000);
  await s.db.app.withBusiness(bravo.business, async (tx) => {
    await grantTo(tx, bravo.decider, 'decide', undefined, false, 'billing');
    await grantTo(tx, bravo.decider, 'decide', undefined, false, 'gate');
  });
  return bravo;
}

/** Answers and approvals as another business counts them: its own, none of alpha's. */
async function answersSeenBy(bravo: Schedules): Promise<number | undefined> {
  const [counted] = await s.db.app.withBusiness(
    bravo.business,
    async (tx) =>
      await tx.query<{ n: number }>(
        `select (select count(*) from public.budget_answers)::int
            + (select count(*) from public.budget_approvals)::int as n`,
      ),
  );
  return counted?.n;
}

async function plantedFrom(bravo: Schedules, runId: string): Promise<readonly unknown[]> {
  return await s.db.app.withBusiness(
    bravo.business,
    async (tx) =>
      await tx.query(
        `insert into public.budget_answers
           (business_id, id, ask_id, run_id, kind, first_person_id)
         select $1, $2, k.id, k.run_id, 'end', $3 from public.budget_asks k where k.run_id = $4
         returning id`,
        [bravo.business, randomUUID(), bravo.decider.personId, runId],
      ),
  );
}

it('AW-05 isolation: the answers', async () => {
  const { work, runId } = await stopped('aw05 answers isolation');
  const before = await moneyOf(runId);

  // 1. Another business: its holder, in its own tenancy, finds no such run.
  const bravo = await bravoHolding();
  for (const answer of [end, topUp]) {
    // eslint-disable-next-line no-await-in-loop
    const refused = await answer(as(bravo.decider, runId), bravo.business);
    expect(codeOf(refused)).toBe('NOT_FOUND');
    expect(JSON.stringify(refused)).not.toContain(work.taskId);
  }

  // 2. The same business, a person whose grants cover another task only (the
  // client stand-in until C32).
  const scoped = await enrol(s.db.app, s.business, 'scoped');
  await s.db.app.withBusiness(s.business, async (tx) => {
    const elsewhere = { kind: 'record' as const, id: randomUUID() };
    await grantTo(tx, scoped, 'decide', elsewhere, false, 'billing');
    await grantTo(tx, scoped, 'decide', elsewhere, false, 'gate');
  });
  expect(codeOf(await end(as(scoped, runId)))).toBe('SCOPE_NOT_GRANTED');
  expect(codeOf(await topUp(as(scoped, runId)))).toBe('SCOPE_NOT_GRANTED');

  // 3. Another person's agent under its own live delegation answers nothing.
  const agent: BudgetAnswerRequest = {
    runId,
    caller: { kind: 'agent', actorId: bravo.agentActorId },
    subjects: [{ kind: 'actor', id: bravo.agentActorId }],
  };
  expect(codeOf(await end(agent))).toBe('DELEGATION_EXCLUDES_DECISION');

  expect(await moneyOf(runId)).toEqual(before);
  expect(await answersSeenBy(bravo)).toBe(0);
  // Planting an answer on alpha's run from bravo's tenancy writes nothing.
  expect(await plantedFrom(bravo, runId)).toHaveLength(0);
  expect(await moneyOf(runId)).toEqual(before);
});
