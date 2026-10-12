// SPDX-License-Identifier: AGPL-3.0-only
//
// A run waits at its budget on one ask, its stopped step's cost unknown and
// its one call having spent the whole hold. Two writes read and then act on
// it. The end reads the step's unknown cost under its locks and refuses until
// the cost is recorded (`observedRefusal`). A person's `nothing_happened`
// leaves the step nothing to hold, so it stops at a spent hold, which reads the
// run's state and raises no second ask on a run already waiting
// (`stopAtSpentHold`).
//
// The two meet on connections of their own, each seen waiting behind a third
// holding the run row, in either order. Each one's commit is also cut at a
// named point, and each one's writes made to throw in turn, then the same
// intent is sent again under its operation id. Every path ends where the plain
// sequence does: the cost recorded once, one ask, one answer, the run
// cancelled, and the envelope and cap moved by the same amount.

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import { codeOf } from '../runtime/schedules-harness.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { failingAt, moneyOf, people, usePeople } from './budget-answers-world.ts';
import { stateOf } from './observed-hold-world.ts';
import {
  as,
  cutAt,
  POINTS,
  queued,
  waitingUnknown,
  type Racer,
  type Waiting,
} from './budget-stop-race-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('endoutcomerace');
usePeople();

/** Waiting on one ask, the step's cost unknown above the hold, its one call the whole hold. */
const waitingSpent = async (): Promise<Waiting> => await waitingUnknown(true);

const outcomeBody = (at: Waiting, operationId: string) => ({
  command: 'budget.record_outcome',
  operationId,
  recordId: at.w.taskId,
  attemptId: at.w.attemptId,
  outcome: 'nothing_happened',
});

const endBody = (at: Waiting, operationId: string) => ({
  command: 'run.end_at_budget_stop',
  operationId,
  recordId: at.w.taskId,
  runId: at.runId,
  askId: at.askId,
});

/** What a path moves, less the cap's total, which every task in this file shares. */
async function figuresOf(at: Waiting) {
  const { cap_committed: _cap, ...rest } = await stateOf(at.runId, at.w.attemptId);
  return rest;
}

/** The cap's committed total and this task's envelope, so the two can be shown to move together. */
async function committedOf(at: Waiting): Promise<{ cap: bigint; envelope: bigint }> {
  const money = await moneyOf(at.runId);
  return {
    cap: BigInt(money.cap_committed),
    envelope: BigInt(money.envelope_held) + BigInt(money.envelope_actual),
  };
}

type Figures = Awaited<ReturnType<typeof figuresOf>>;

/** The plain sequence, one write after the other: what every race and retry must end at. */
let recorded: Figures;
let ended: Figures;

beforeAll(async () => {
  if (noDatabase) return;
  const at = await waitingSpent();
  expect(codeOf(await as(s.db.app, s.decider, outcomeBody(at, randomUUID())))).toBe('applied');
  recorded = await figuresOf(at);
  expect(recorded).toMatchObject({ run: 'waiting_budget', attempt: 'abandoned', asks: 1 });
  expect(codeOf(await as(s.db.app, people.second, endBody(at, randomUUID())))).toBe('applied');
  ended = await figuresOf(at);
  expect(ended).toMatchObject({ run: 'cancelled', asks: 1, answers: 1, envelope_held: '0' });
}, 120_000);

/** `first` then `second`, queued in that order behind a third connection holding the run row. */
const raced = async (at: Waiting, first: Racer, second: Racer): Promise<readonly string[]> =>
  (await queued({ table: 'planned_runs', id: at.runId }, first, second)).map((result) =>
    codeOf(result),
  );

it('an outcome and an end on separate connections, the outcome first: both apply, one ask, one answer', async () => {
  const at = await waitingSpent();
  const before = await committedOf(at);
  const codes = await raced(
    at,
    async (database) => await as(database, s.decider, outcomeBody(at, randomUUID())),
    async (database) => await as(database, people.second, endBody(at, randomUUID())),
  );
  expect(codes).toEqual(['applied', 'applied']);
  expect(await figuresOf(at)).toEqual(ended);
  const after = await committedOf(at);
  expect(after.cap - before.cap).toBe(after.envelope - before.envelope);
});

it('an end and an outcome on separate connections, the end first: the end is refused and writes nothing, the outcome applies once', async () => {
  const at = await waitingSpent();
  const before = await committedOf(at);
  const codes = await raced(
    at,
    async (database) => await as(database, people.second, endBody(at, randomUUID())),
    async (database) => await as(database, s.decider, outcomeBody(at, randomUUID())),
  );
  expect(codes).toEqual(['TRANSITION_NOT_PERMITTED', 'applied']);
  expect(await figuresOf(at)).toEqual(recorded);
  // The person ends the work again, a new intent after the refusal.
  expect(codeOf(await as(s.db.app, people.second, endBody(at, randomUUID())))).toBe('applied');
  expect(await figuresOf(at)).toEqual(ended);
  const after = await committedOf(at);
  expect(after.cap - before.cap).toBe(after.envelope - before.envelope);
});

it('two outcomes on separate connections record the cost once and raise no second ask', async () => {
  const at = await waitingSpent();
  const codes = await raced(
    at,
    async (database) => await as(database, s.decider, outcomeBody(at, randomUUID())),
    async (database) => await as(database, s.decider, outcomeBody(at, randomUUID())),
  );
  expect(codes).toEqual(['applied', 'LIABILITY_NOT_UNKNOWN']);
  expect(await figuresOf(at)).toEqual(recorded);
});

it.each(POINTS)(
  'an outcome whose commit is cut %s, sent again under its operation id, is recorded once',
  async (point) => {
    const at = await waitingSpent();
    const waitingFigures = await figuresOf(at);
    const operationId = randomUUID();
    await cutAt(
      point,
      async (database) => await as(database, s.decider, outcomeBody(at, operationId)),
    );
    expect(await figuresOf(at)).toEqual(point === 'after-commit' ? recorded : waitingFigures);
    expect(codeOf(await as(s.db.app, s.decider, outcomeBody(at, operationId)))).toBe('applied');
    expect(await figuresOf(at)).toEqual(recorded);
    expect(codeOf(await as(s.db.app, people.second, endBody(at, randomUUID())))).toBe('applied');
    expect(await figuresOf(at)).toEqual(ended);
  },
);

it.each(POINTS)(
  'an end whose commit is cut %s, sent again under its operation id, ends the run once',
  async (point) => {
    const at = await waitingSpent();
    expect(codeOf(await as(s.db.app, s.decider, outcomeBody(at, randomUUID())))).toBe('applied');
    const operationId = randomUUID();
    await cutAt(
      point,
      async (database) => await as(database, people.second, endBody(at, operationId)),
    );
    expect(await figuresOf(at)).toEqual(point === 'after-commit' ? ended : recorded);
    expect(codeOf(await as(s.db.app, people.second, endBody(at, operationId)))).toBe('applied');
    expect(await figuresOf(at)).toEqual(ended);
  },
);

it('an outcome that throws at each of its writes keeps nothing, and sent again under its operation id is recorded once', async () => {
  const at = await waitingSpent();
  const waitingFigures = await figuresOf(at);
  const operationId = randomUUID();
  for (const [table, event] of [
    ['reservations', 'update'],
    ['task_envelopes', 'update'],
    ['attempts', 'update'],
    ['operations', 'insert'],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop
    const crashed = await failingAt(
      table,
      event,
      async () => await as(s.db.app, s.decider, outcomeBody(at, operationId)),
    );
    expect(String(crashed), `${table} ${event}`).toContain('planted crash');
    // eslint-disable-next-line no-await-in-loop
    expect(await figuresOf(at)).toEqual(waitingFigures);
  }
  expect(codeOf(await as(s.db.app, s.decider, outcomeBody(at, operationId)))).toBe('applied');
  expect(await figuresOf(at)).toEqual(recorded);
});

it('an end that throws at each of its writes keeps nothing, and sent again under its operation id ends the run once', async () => {
  const at = await waitingSpent();
  expect(codeOf(await as(s.db.app, s.decider, outcomeBody(at, randomUUID())))).toBe('applied');
  const operationId = randomUUID();
  // The outcome closed the hold, so the end writes its answer, the run and its operation only.
  for (const [table, event] of [
    ['budget_answers', 'insert'],
    ['planned_runs', 'update'],
    ['operations', 'insert'],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop
    const crashed = await failingAt(
      table,
      event,
      async () => await as(s.db.app, people.second, endBody(at, operationId)),
    );
    expect(String(crashed), `${table} ${event}`).toContain('planted crash');
    // eslint-disable-next-line no-await-in-loop
    expect(await figuresOf(at)).toEqual(recorded);
  }
  expect(codeOf(await as(s.db.app, people.second, endBody(at, operationId)))).toBe('applied');
  expect(await figuresOf(at)).toEqual(ended);
});
