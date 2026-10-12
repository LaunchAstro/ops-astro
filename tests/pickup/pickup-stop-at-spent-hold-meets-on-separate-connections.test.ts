// SPDX-License-Identifier: AGPL-3.0-only
//
// A pickup of a hold its calls spent whole stops the run at its budget and
// asks (`stopSpentWhole`, `stopAtSpentHold`): it reads the run's state, claims
// a `planned` run and raises the ask, and raises nothing on a run already
// waiting. Two pickups meet on connections of their own, each seen waiting
// behind a third holding the run row; a pickup's commit is cut at a named
// point, and its writes made to throw in turn, then it is sent again under its
// operation id. Every path leaves one ask on a waiting run and the hold as the
// classifier settled it.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { codeOf, type Work } from '../runtime/schedules-harness.ts';
import { noDatabase, s, useBrokerWorld } from '../broker/broker-world.ts';
import { failingAt, one } from '../broker/budget-answers-world.ts';
import { as, cutAt, POINTS, queued, type Racer } from '../broker/budget-stop-race-world.ts';
import { asksOn, holdsOn, spentWhole } from '../runtime/resume-sizing-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('stoprace');

const pickupBody = (work: Work, operationId: string) => ({
  command: 'task.pickup',
  operationId,
  reservationId: work.decision['reservationId'],
  leaseSeconds: 600,
});

/** The agent's pickup of `work`, under `operationId`. */
const byAgent =
  (work: Work, operationId = randomUUID()): Racer =>
  async (database: Database) =>
    (await executeAgentCommand(
      database,
      s.business,
      s.agent,
      undefined,
      pickupBody(work, operationId) as never,
    )) as CommandResult;

/** The decider's own pickup of `work`. */
const byPerson =
  (work: Work): Racer =>
  async (database: Database) =>
    await as(database, s.decider, pickupBody(work, randomUUID()));

const runIdOf = async (work: Work): Promise<string> =>
  (
    await one<{ run_id: string }>('select run_id from public.reservations where id = $1', [
      work.decision['reservationId'],
    ])
  ).run_id;

/** The stop's one ask on a waiting run, and the hold settled at its whole spend. */
async function stoppedOnce(work: Work): Promise<void> {
  expect(await asksOn(work)).toEqual([
    { run_state: 'waiting_budget', ceiling: '500', spent: '500', kind: 'stop' },
  ]);
  expect((await holdsOn(work)).map((row) => row.state)).toEqual(['actual']);
}

it.each([
  ['an agent and then a person', byAgent, byPerson],
  ['a person and then an agent', byPerson, byAgent],
] as const)(
  'two pickups of a spent-whole hold on separate connections, %s, raise one ask',
  async (_order, first, second) => {
    const work = await spentWhole(`raced ${randomUUID()}`);
    const [ahead, behind] = (
      await queued({ table: 'planned_runs', id: await runIdOf(work) }, first(work), second(work))
    ).map((result) => codeOf(result));
    expect(ahead).toBe('BUDGET_UNAVAILABLE');
    expect(behind).not.toBe('applied');
    await stoppedOnce(work);
  },
);

it.each(POINTS)(
  'a pickup at a spent-whole hold whose commit is cut %s, sent again under its operation id, raises one ask',
  async (point) => {
    const work = await spentWhole(`cut ${point} ${randomUUID()}`);
    const operationId = randomUUID();
    await cutAt(point, byAgent(work, operationId));
    expect(await asksOn(work)).toHaveLength(point === 'after-commit' ? 1 : 0);
    expect(codeOf(await byAgent(work, operationId)(s.db.app))).toBe('BUDGET_UNAVAILABLE');
    await stoppedOnce(work);
  },
);

it('a pickup at a spent-whole hold that throws at each of its writes keeps no ask, and sent again under its operation id raises one', async () => {
  const work = await spentWhole(`throws ${randomUUID()}`);
  const operationId = randomUUID();
  for (const [table, event] of [
    ['planned_runs', 'update'],
    ['budget_asks', 'insert'],
    ['operations', 'insert'],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop
    const crashed = await failingAt(
      table,
      event,
      async () => await byAgent(work, operationId)(s.db.app),
    );
    expect(String(crashed), `${table} ${event}`).toContain('planted crash');
    // eslint-disable-next-line no-await-in-loop
    expect(await asksOn(work)).toEqual([]);
  }
  expect(codeOf(await byAgent(work, operationId)(s.db.app))).toBe('BUDGET_UNAVAILABLE');
  await stoppedOnce(work);
});
