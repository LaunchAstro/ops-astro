// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// #1719 (R10): a stopped run's outcome is said in plain words on the task page,
// from one explicit table (`outcome-words.ts`), with its own words for "sign in
// to the plan again" (`SUBSCRIPTION_SIGN_IN_NEEDED`). The words come from the
// stop the execution read carries, which the stop's transaction stored
// (`run_outcomes`), so they are the same after the API restarts. Restart
// sends `task.restart` for the run's lineage, which starts a fresh attempt
// (server side: `tests/runs/a-plan-answer-ends-the-run-in-its-own-outcome-with-no-retry.test.ts`).

import { afterEach, describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { OUTCOME_WORDS, SIGN_IN_WORDS } from '../../apps/web/src/screens/task/outcome-words.ts';
import { RUN_OUTCOMES, type RunOutcome } from '../../packages/core-wire/src/index.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { TASK_ID, task, tick } from './task-page-stub.tsx';

const LINEAGE = '44444444-4444-4444-8444-444444444444';
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Stop {
  readonly outcome: RunOutcome;
  readonly endCode: string;
  /** A newer run the restart opened, claimed and with no stop yet. */
  readonly restarted?: boolean;
}

/** The execution read of a task whose one run stopped as `stop`, as the stop stored it. */
const executionOf = (stop: Stop) => ({
  ok: true,
  execution: {
    taskId: TASK_ID,
    outcome: 'ready',
    sourceRevision: 3,
    complete: true,
    next: null,
    events: [],
    runs: [
      {
        runId: '55555555-5555-4555-8555-555555555555',
        lineageId: LINEAGE,
        versionId: '66666666-6666-4666-8666-666666666666',
        // As the server leaves it: a stop releases the lease, the run stays claimed (`retireAttempt`).
        state: stop.outcome === 'success' ? 'handed_back' : 'claimed',
        taskRevisionAtRequest: 1,
        createdAt: '2026-11-14T10:00:00Z',
        runOutcome: {
          attemptId: '77777777-7777-4777-8777-777777777777',
          outcome: stop.outcome,
          endCode: stop.endCode,
        },
      },
      ...(stop.restarted === true
        ? [
            {
              runId: '88888888-8888-4888-8888-888888888888',
              lineageId: '99999999-9999-4999-8999-999999999999',
              versionId: '66666666-6666-4666-8666-666666666666',
              state: 'claimed',
              taskRevisionAtRequest: 2,
              createdAt: '2026-11-14T11:00:00Z',
              runOutcome: null,
            },
          ]
        : []),
    ],
  },
});

const RESTARTED: { status: number; body: unknown } = {
  status: 200,
  body: { recordId: TASK_ID, revision: 2 },
};

/** A task page whose one run stopped as `stop`; every write it sends is kept. */
function serving(stop: Stop, restart: { status: number; body: unknown }) {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const reads = { execution: 0 };
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    if (at.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
    if (at.endsWith('/task/execution')) {
      reads.execution += 1;
      return Promise.resolve(json(executionOf(stop)));
    }
    if (at.endsWith('/task/read'))
      return Promise.resolve(json({ ok: true, task: task({ proposals: [] }) }));
    sent.push({ path: new URL(at, 'http://x.invalid').pathname, body });
    if (at.endsWith('/task/restart')) return Promise.resolve(json(restart.body, restart.status));
    return Promise.resolve(json({ recordId: TASK_ID, revision: 2 }));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { client, sent, reads };
}

const views: Mounted[] = [];
afterEach(async () => {
  await Promise.all(views.splice(0).map(async (view) => await view.unmount()));
});

async function opened(stop: Stop, restart = RESTARTED) {
  const served = serving(stop, restart);
  const view = await mount(
    <TaskDetailScreen
      client={served.client}
      grantKey="alpha:member"
      taskKey="Proj-Verity-Pacing"
    />,
  );
  views.push(view);
  await tick();
  return { ...served, view, line: () => view.find('[data-run]')?.textContent ?? '' };
}

describe('the outcome words table', () => {
  it('has words of its own for every outcome, and for the plan sign-in', () => {
    expect(Object.keys(OUTCOME_WORDS).toSorted()).toStrictEqual([...RUN_OUTCOMES].toSorted());
    const words = [...Object.values(OUTCOME_WORDS), SIGN_IN_WORDS];
    expect(new Set(words).size, 'no two outcomes share words').toBe(words.length);
    for (const one of words) expect(one.trim().length).toBeGreaterThan(10);
  });
});

describe('a stopped run on the task page', () => {
  it.each(RUN_OUTCOMES.map((outcome) => [outcome] as const))(
    '%s is said in its own words',
    async (outcome) => {
      const { line } = await opened({
        outcome,
        endCode: outcome === 'success' ? 'COMPLETED' : 'TASK_CANCELLED',
      });
      expect(line()).toContain(OUTCOME_WORDS[outcome]);
    },
  );

  it('the plan sign-in stop says to sign in to the plan again, not just cancelled', async () => {
    const { line } = await opened({ outcome: 'cancelled', endCode: 'SUBSCRIPTION_SIGN_IN_NEEDED' });
    expect(line()).toContain(SIGN_IN_WORDS);
    expect(line()).not.toContain(OUTCOME_WORDS.cancelled);
  });
});

describe('Restart after a stop', () => {
  it('Restart sends task.restart for the run’s lineage and reads the task again', async () => {
    const { view, sent, reads } = await opened({
      outcome: 'cancelled',
      endCode: 'SUBSCRIPTION_SIGN_IN_NEEDED',
    });
    const before = reads.execution;
    await view.click('[data-run-restart]');
    await tick();
    expect(
      sent.filter((one) => one.path.endsWith('/task/restart')).map((one) => one.body),
    ).toMatchObject([{ recordId: TASK_ID, lineageId: LINEAGE }]);
    expect(reads.execution, 'the run is read again').toBeGreaterThan(before);
  });

  it('a refused restart is quoted in the server’s words', async () => {
    const refusal = {
      refused: true,
      code: 'SCOPE_NOT_GRANTED',
      names: [],
      fixes: ['Ask for decide on this task.'],
    };
    const { view } = await opened(
      { outcome: 'budget_wait', endCode: 'BUDGET_UNAVAILABLE' },
      { status: 403, body: refusal },
    );
    await view.click('[data-run-restart]');
    await tick();
    expect(view.find('[data-run-restart-refusal]')?.textContent).toContain(
      'Ask for decide on this task.',
    );
  });

  it('after a restart the newer run is drawn, not the old stop', async () => {
    const { view, line } = await opened({
      outcome: 'cancelled',
      endCode: 'SUBSCRIPTION_SIGN_IN_NEEDED',
      restarted: true,
    });
    expect(line()).toContain('running');
    expect(line()).not.toContain(SIGN_IN_WORDS);
    expect(view.find('[data-run-restart]')).toBeNull();
  });

  it('a finished run offers no restart', async () => {
    const { view } = await opened({ outcome: 'success', endCode: 'COMPLETED' });
    expect(view.find('[data-run-restart]')).toBeNull();
  });
});
