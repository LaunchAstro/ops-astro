// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-05's answers, part 2: the top-up. A person holding `billing:decide`
// raises the stopped run's approved ceiling within the business cap, and the
// run goes back for a fresh pickup that holds the raised ceiling less what is
// already spent. The plan approver answers where they hold the permission,
// otherwise any holder. Above the business's four-eyes threshold one person is
// not enough: the first approval is recorded and applies nothing, and a second,
// distinct holder completes it. Threshold, cap, currency and approvals are read
// under the run's locks at decision time; a failed answer applies nothing.

import { expect, it as vitestIt } from 'vitest';
import {
  topUpAtBudgetStop,
  type BudgetAnswerRequest,
} from '../../packages/core-runtime/src/index.ts';
import { liveWork, pickup, racer } from '../runtime/schedules-harness.ts';
import { call, noDatabase, s, useBrokerWorld, world } from './broker-world.ts';
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

/** Exactly the replay operation's priced maximum: one call fits, and none after it. */
const ONE_CALL = 500;

useBrokerWorld('aw05topup');
usePeople();

const topUp = async (
  request: BudgetAnswerRequest,
  amountMinor: number,
  currency = 'AUD',
  database = s.db.app,
) =>
  await database.withBusiness(
    s.business,
    async (tx) => await topUpAtBudgetStop(tx, { ...request, amountMinor, currency }),
  );

const codeOf = (result: { ok: boolean; refusal?: { code: string } }) =>
  result.ok ? 'applied' : result.refusal?.code;

const wordsOf = (result: { ok: boolean; refusal?: { fixes: readonly string[] } }) =>
  result.ok ? '' : (result.refusal?.fixes ?? []).join(' ');

it('AW-05 the plan approver tops up within the cap and the run goes back for pickup', async () => {
  await setThreshold(500);
  const { work, runId } = await stopped('aw05 top up');
  const before = await moneyOf(runId);

  const answered = await topUp(as(people.approver, runId), 600);
  expect(answered).toMatchObject({ ok: true, value: { state: 'applied', heldMinor: 1000 } });

  const after = await moneyOf(runId);
  expect(after).toMatchObject({
    run: 'planned',
    reservation: 'held',
    held: String(UNDER_ONE_CALL + 600),
    maximum: String(Number(before.maximum) + 600),
    envelope_held: String(Number(before.envelope_held) + 600),
    envelope_actual: before.envelope_actual,
    cap_committed: String(Number(before.cap_committed) + 600),
    answers: 1,
    approvals: 1,
    asks: 1,
  });

  // Re-leased: the fresh pickup holds the raised ceiling, and the next call spends.
  const again = await pickup(s, work.decision['reservationId']);
  const seen = world.provider.seen.length;
  const result = await call({ ...work, picked: again });
  expect(result.ok).toBe(true);
  expect(world.provider.seen.length - seen).toBe(1);
  expect(await moneyOf(runId)).toMatchObject({
    run: 'claimed',
    held: String(UNDER_ONE_CALL + 600),
    cap_committed: after.cap_committed,
  });
});

it('AW-05 the spend to date is kept and never spent again after a top-up', async () => {
  await setThreshold(500);
  // A 500 ceiling holds one call priced at most 500; the second stops with the first's spend recorded.
  const work = await liveWork(s, 'aw05 spend kept', ONE_CALL);
  world.provider.mode('answer');
  expect((await call(work)).ok).toBe(true);
  expect((await call(work)).ok).toBe(false);
  const { run_id: runId, spent_minor: spent } = await one<{ run_id: string; spent_minor: string }>(
    `select run_id, spent_minor::text as spent_minor from public.budget_asks where lease_id = $1`,
    [work.picked['leaseId']],
  );
  expect(Number(spent)).toBeGreaterThan(0);
  const first = await moneyOf(runId);

  expect((await topUp(as(people.approver, runId), 300)).ok).toBe(true);
  // The run may spend the raised ceiling less what it has spent, and no more:
  // the spend moves to the envelope's actual, and the cap counts it once.
  expect(await moneyOf(runId)).toMatchObject({
    held: String(ONE_CALL + 300 - Number(spent)),
    envelope_actual: String(Number(first.envelope_actual) + Number(spent)),
    cap_committed: String(Number(first.cap_committed) + 300),
  });
  const again = await pickup(s, work.decision['reservationId']);
  expect(await moneyOf(runId)).toMatchObject({
    run: 'claimed',
    held: String(ONE_CALL + 300 - Number(spent)),
    cap_committed: String(Number(first.cap_committed) + 300),
  });
  expect(again['leaseId']).not.toBe(work.picked['leaseId']);
});

it('AW-05 another holder is refused while the plan approver holds billing:decide', async () => {
  await setThreshold(500);
  const { runId } = await stopped('aw05 approver first');
  const before = await moneyOf(runId);
  const refused = await topUp(as(people.second, runId), 100);
  expect(codeOf(refused)).toBe('SCOPE_NOT_GRANTED');
  expect(wordsOf(refused)).toContain('plan approver');
  expect(await moneyOf(runId)).toEqual(before);

  // Without the grant, the plan approver is not asked, and any holder answers.
  const bare = await topUp(as(people.bare, runId), 100);
  expect(codeOf(bare)).toBe('SCOPE_NOT_GRANTED');
  expect(await moneyOf(runId)).toEqual(before);
});

it('AW-05 above the threshold one approver is refused, naming the threshold, and a second completes it', async () => {
  // One dollar: 100 minor units of AUD.
  await setThreshold(1);
  const { runId } = await stopped('aw05 four eyes');
  const before = await moneyOf(runId);

  const first = await topUp(as(people.approver, runId), 300);
  expect(first).toMatchObject({
    ok: true,
    value: { state: 'awaiting_second', thresholdMinor: 100 },
  });
  // Recorded, and nothing moved: the run still waits and nothing is spent.
  expect(await moneyOf(runId)).toEqual({ ...before, approvals: 1 });

  // The same person twice is one approver.
  const self = await topUp(as(people.approver, runId), 300);
  expect(codeOf(self)).toBe('FOUR_EYES_REQUIRED');
  expect(wordsOf(self)).toContain('1.00 AUD');
  expect(await moneyOf(runId)).toEqual({ ...before, approvals: 1 });

  // A second approval is of the same top-up, or none.
  const other = await topUp(as(people.second, runId), 301);
  expect(codeOf(other)).toBe('FIELD_VALUE_INVALID');
  expect(await moneyOf(runId)).toEqual({ ...before, approvals: 1 });

  const second = await topUp(as(people.second, runId), 300);
  expect(second).toMatchObject({ ok: true, value: { state: 'applied' } });
  expect(await moneyOf(runId)).toMatchObject({
    run: 'planned',
    held: String(UNDER_ONE_CALL + 300),
    answers: 1,
    approvals: 2,
  });
});

it('AW-05 two approvers at once apply one top-up', async () => {
  await setThreshold(1);
  const { runId } = await stopped('aw05 two at once');
  expect((await topUp(as(people.approver, runId), 300)).ok).toBe(true);
  const before = await moneyOf(runId);

  const [a, b] = [racer(s), racer(s)];
  try {
    const answers = await Promise.all([
      topUp(as(people.second, runId), 300, 'AUD', a),
      topUp(as(people.third, runId), 300, 'AUD', b),
    ]);
    expect(answers.map((answer) => codeOf(answer)).toSorted()).toEqual([
      'TRANSITION_NOT_PERMITTED',
      'applied',
    ]);
  } finally {
    await a.close();
    await b.close();
  }
  expect(await moneyOf(runId)).toMatchObject({
    run: 'planned',
    held: String(UNDER_ONE_CALL + 300),
    cap_committed: String(Number(before.cap_committed) + 300),
    answers: 1,
    approvals: 2,
  });
});

it('AW-05 the threshold is read under lock when the top-up is decided', async () => {
  await setThreshold(500);
  const { runId } = await stopped('aw05 threshold under lock');
  const writer = racer(s);
  const answerer = racer(s);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const writing = new Promise<void>((resolve) => {
    started = resolve;
  });
  try {
    // A threshold change in flight: written, not yet committed.
    const change = writer.withBusiness(s.business, async (tx) => {
      await tx.query(
        `update business_settings set value = '1'::jsonb
          where business_id = $1 and key = 'four_eyes_threshold'`,
        [s.business],
      );
      started();
      await held;
    });
    await writing;
    const answer = topUp(as(people.approver, runId), 300, 'AUD', answerer);
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    release();
    await change;
    // Decided against the committed threshold, never the one it read first.
    expect(await answer).toMatchObject({ ok: true, value: { state: 'awaiting_second' } });
  } finally {
    await writer.close();
    await answerer.close();
  }
  expect(await moneyOf(runId)).toMatchObject({ run: 'waiting_budget', answers: 0, approvals: 1 });
});

it('AW-05 a failed top-up applies nothing, at each step, and a lost response is not applied twice', async () => {
  await setThreshold(1);
  const { runId } = await stopped('aw05 top up crashes');
  const before = await moneyOf(runId);
  // The first approval's one write.
  expect(
    String(
      await failingAt('budget_approvals', 'insert', () => topUp(as(people.approver, runId), 300)),
    ),
  ).toContain('planted crash');
  expect(await moneyOf(runId)).toEqual(before);

  expect((await topUp(as(people.approver, runId), 300)).ok).toBe(true);
  const approved = await moneyOf(runId);
  for (const [table, event] of [
    ['budget_approvals', 'insert'],
    ['budget_answers', 'insert'],
    ['reservations', 'update'],
    ['task_envelopes', 'update'],
    ['planned_runs', 'update'],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop
    const crashed = await failingAt(table, event, () => topUp(as(people.second, runId), 300));
    expect(String(crashed)).toContain('planted crash');
    // eslint-disable-next-line no-await-in-loop
    expect(await moneyOf(runId)).toEqual(approved);
  }

  expect((await topUp(as(people.second, runId), 300)).ok).toBe(true);
  const applied = await moneyOf(runId);
  // The response is lost and the same answer is sent again: refused, and nothing moves twice.
  const replayed = await topUp(as(people.second, runId), 300);
  expect(codeOf(replayed)).toBe('TRANSITION_NOT_PERMITTED');
  expect(await moneyOf(runId)).toEqual(applied);
});

// Last: it tops up to exactly the cap, leaving no room for new work.
it('AW-05 the business cap is the hard ceiling, in its own currency', async () => {
  await setThreshold(null);
  const { runId } = await stopped('aw05 the cap holds');
  const before = await moneyOf(runId);
  const room = 1_000_000 - Number(before.cap_committed);

  const over = await topUp(as(people.approver, runId), room + 1);
  expect(codeOf(over)).toBe('BUDGET_EXHAUSTED');
  expect(await moneyOf(runId)).toEqual(before);

  const currency = await topUp(as(people.approver, runId), 100, 'USD');
  expect(codeOf(currency)).toBe('CAP_BINDING_MISMATCH');
  expect(await moneyOf(runId)).toEqual(before);

  for (const amount of [0, -5, 1.5, Number.NaN]) {
    // eslint-disable-next-line no-await-in-loop
    expect(codeOf(await topUp(as(people.approver, runId), amount))).toBe('FIELD_VALUE_INVALID');
  }
  expect(await moneyOf(runId)).toEqual(before);

  // Exactly to the cap fits.
  expect((await topUp(as(people.approver, runId), room)).ok).toBe(true);
});
