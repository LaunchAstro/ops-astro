// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5's client lock on an onboarding step's task (C41-A): a step's result is
// content on its task, so it takes the task's row lock and asks again, under
// it, whether the task is still on the onboarding's client. Raced both ways
// against `task.set_party`, each held at the audit-chain lock uncommitted.

import { describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { detail, useMoveWorld } from './c41-a-move-world.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, the races that share it
describe.skipIf(serverUrl === undefined)('C41-A a step result under its task lock', () => {
  const { the, as, onboard, revisionOf, race } = useMoveWorld('c41alock');

  /** The step's failures and how many comments its task holds, read past row security. */
  const resultsOn = async (taskId: string): Promise<readonly [number, number]> => {
    const [row] = await the.controls.fixture.db.admin.execute<{
      readonly failures: string;
      readonly comments: string;
    }>(
      `select (select failures from public.onboarding_steps where task_id = $1)::text as failures,
              (select count(*) from public.records where data ->> 'task' = $1::text)::text as comments`,
      [taskId],
    );
    return [Number(row?.failures), Number(row?.comments)];
  };

  const moveTo = async (taskId: string, name: string): Promise<Record<string, unknown>> => {
    const other = await as(the.admin, 'record.create', { type: 'client', fields: { name } });
    expect(other.status).toBe(200);
    return {
      recordId: taskId,
      expectedRevision: await revisionOf(taskId),
      fields: { client: String(detail(other)['recordId']) },
    };
  };

  it('S0-5 lock order: a step result racing its task moving to another client is refused under the task lock, writing nothing', async () => {
    const steps = await onboard('Made-up Client Move Race');
    const welcome = String(steps.get('welcome-email'));
    // The move holds the task's row lock, uncommitted; the result comes meanwhile.
    const answers = await race(
      { name: 'task.set_party', body: await moveTo(welcome, 'Made-up Client Moved To') },
      {
        name: 'onboarding.step_result',
        body: { recordId: welcome, outcome: 'failed', result: 'bounced' },
      },
    );
    expect(answers.map((answer) => answer.status)).toStrictEqual([200, 404]);
    // The task is another client's: no result of this onboarding is on it.
    expect(await resultsOn(welcome)).toStrictEqual([0, 0]);
  });

  it('S0-5 lock order: a task moving to another client racing a step result on it is refused CLIENT_LOCKED', async () => {
    const steps = await onboard('Made-up Client Result Race');
    const welcome = String(steps.get('welcome-email'));
    // The result holds the task's row lock, uncommitted; the move comes meanwhile.
    const body = await moveTo(welcome, 'Made-up Client Not Moved To');
    const answers = await race(
      {
        name: 'onboarding.step_result',
        body: { recordId: welcome, outcome: 'failed', result: 'bounced' },
      },
      { name: 'task.set_party', body },
    );
    expect(answers[0].status, JSON.stringify(answers[0].body)).toBe(200);
    expect([answers[1].status, answers[1].body['code']]).toStrictEqual([409, 'CLIENT_LOCKED']);
    expect(await resultsOn(welcome)).toStrictEqual([1, 1]);
  });
});
