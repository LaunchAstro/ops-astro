// SPDX-License-Identifier: AGPL-3.0-only
//
// Where a step's owed move ends and comes back (C41-A, CS-15.4): an onboarding
// that stops withdraws every open move of its steps, since none of them takes
// a result any more; and a person step that opened while its task was in the
// trash is parked with its owner when the task is restored.

import { describe, expect, it } from 'vitest';
import { pathFaults } from '../operations/s0-5-effect-diff.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { detail, useMoveWorld } from './c41-a-move-world.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, the two ends that share it
describe.skipIf(serverUrl === undefined)('C41-A step moves at stop and restore', () => {
  const { the, as, onboard, done, revisionOf, assign, openOn, race } = useMoveWorld('c41aend');

  /** Every assignment item on these tasks: recipient and state, read past row security. */
  const itemsOn = async (tasks: readonly string[]): Promise<readonly unknown[]> =>
    await the.controls.fixture.db.admin.execute(
      `select subject_record_id::text as task, recipient_person_id::text as recipient, work_state
         from public.inbox_items
        where subject_record_id = any($1::uuid[]) and reason = 'assignment'
        order by subject_record_id, work_state`,
      [tasks],
    );

  it('C41-A stop: the second failure withdraws the open moves of every step of the onboarding, and none is owed after', async () => {
    const steps = await onboard('Made-up Client Stop Withdraws');
    const on = (key: string): string => String(steps.get(key));
    await done(steps, 'welcome-email');
    await done(steps, 'kickoff-call');
    const parked = [on('access-grant'), on('site-setup')];
    // A blocked step's task assigned meanwhile: an ordinary assignment, no step's move.
    const assigned = await assign(the.admin, on('access-check'), the.assignee.personId);
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect(await Promise.all(parked.map(async (task) => await openOn(task)))).toStrictEqual([
      [the.admin.personId],
      [the.admin.personId],
    ]);
    for (const attempt of ['first', 'second']) {
      // oxlint-disable-next-line no-await-in-loop -- the second failure follows the first
      const failed = await as(the.admin, 'onboarding.step_result', {
        recordId: on('site-setup'),
        outcome: 'failed',
        result: `${attempt} attempt failed`,
      });
      expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    }
    expect(await itemsOn(parked)).toEqual(
      parked
        .toSorted()
        .map((task) => ({ task, recipient: the.admin.personId, work_state: 'withdrawn' })),
    );
    expect(await openOn(on('access-check'))).toStrictEqual([the.assignee.personId]);
    const late = await as(the.admin, 'onboarding.step_result', {
      recordId: on('access-grant'),
      outcome: 'done',
      result: 'granted after the stop',
    });
    expect([late.status, late.body['code']]).toStrictEqual([409, 'TRANSITION_NOT_PERMITTED']);
  });

  it('C41-A restore: a person step that opened while its task was in the trash is parked with its owner when the task is restored', async () => {
    const steps = await onboard('Made-up Client Restored Step');
    const kickoff = String(steps.get('kickoff-call'));
    const trashed = await as(the.admin, 'task.trash', {
      recordId: kickoff,
      expectedRevision: await revisionOf(kickoff),
    });
    expect(trashed.status, JSON.stringify(trashed.body)).toBe(200);
    await done(steps, 'welcome-email');
    const [state] = await the.controls.fixture.db.admin.execute<{ readonly state: string }>(
      'select state from public.onboarding_steps where task_id = $1',
      [kickoff],
    );
    expect(state?.state).toBe('ready');
    expect(await openOn(kickoff)).toStrictEqual([]);
    const restored = await as(the.admin, 'task.restore', {
      batchId: detail(trashed)['batchId'],
    });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(await itemsOn([kickoff])).toEqual([
      { task: kickoff, recipient: the.admin.personId, work_state: 'open' },
    ]);
  });

  it('C41-A restore effect: the restore that parks a step writes the inbox item its command declares (S0-5)', async () => {
    const steps = await onboard('Made-up Client Restore Effect');
    const kickoff = String(steps.get('kickoff-call'));
    const faults = await pathFaults(the.controls.fixture.db.admin, {
      name: 'task.restore',
      code: '200',
      drives: ['records', 'inbox_items'],
      prepare: async () => {
        const trashed = await as(the.admin, 'task.trash', {
          recordId: kickoff,
          expectedRevision: await revisionOf(kickoff),
        });
        expect(trashed.status, JSON.stringify(trashed.body)).toBe(200);
        await done(steps, 'welcome-email');
        const batchId = detail(trashed)['batchId'];
        return async () => String((await as(the.admin, 'task.restore', { batchId })).status);
      },
    });
    expect(faults).toStrictEqual([]);
  });

  it('C41-A races: a restore racing the result that opens its task’s step leaves the step parked with its owner', async () => {
    const steps = await onboard('Made-up Client Restore Race');
    const kickoff = String(steps.get('kickoff-call'));
    const trashed = await as(the.admin, 'task.trash', {
      recordId: kickoff,
      expectedRevision: await revisionOf(kickoff),
    });
    expect(trashed.status, JSON.stringify(trashed.body)).toBe(200);
    // The restore holds the task's row, uncommitted, while the result opens its step.
    const answers = await race(
      { name: 'task.restore', body: { batchId: detail(trashed)['batchId'] } },
      {
        name: 'onboarding.step_result',
        body: { recordId: steps.get('welcome-email'), outcome: 'done', result: 'opened' },
      },
    );
    expect(answers.map((answer) => answer.status)).toStrictEqual([200, 200]);
    expect(await itemsOn([kickoff])).toEqual([
      { task: kickoff, recipient: the.admin.personId, work_state: 'open' },
    ]);
  });

  it('C41-A stop crossing: the stop withdraws its own client’s moves and leaves an ordinary assignment on a step task moved to another client open', async () => {
    const steps = await onboard('Made-up Client Stop Keeps Moved');
    const on = (key: string): string => String(steps.get(key));
    await done(steps, 'welcome-email');
    await done(steps, 'kickoff-call');
    const moved = on('access-grant');
    const other = await as(the.admin, 'record.create', {
      type: 'client',
      fields: { name: 'Made-up Client Moved Onto' },
    });
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    const set = await as(the.admin, 'task.set_party', {
      recordId: moved,
      expectedRevision: await revisionOf(moved),
      fields: { client: String(detail(other)['recordId']) },
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const assigned = await assign(the.admin, moved, the.assignee.personId);
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect(await openOn(moved)).toStrictEqual([the.assignee.personId]);
    for (const attempt of ['first', 'second']) {
      // oxlint-disable-next-line no-await-in-loop -- the second failure follows the first
      const failed = await as(the.admin, 'onboarding.step_result', {
        recordId: on('site-setup'),
        outcome: 'failed',
        result: `${attempt} attempt failed`,
      });
      expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    }
    expect(await itemsOn([on('site-setup')])).toEqual([
      { task: on('site-setup'), recipient: the.admin.personId, work_state: 'withdrawn' },
    ]);
    expect(await openOn(moved)).toStrictEqual([the.assignee.personId]);
  });

  it('C41-A races: a restore racing the stop leaves no open move on the stopped onboarding', async () => {
    const steps = await onboard('Made-up Client Restore Stop Race');
    const on = (key: string): string => String(steps.get(key));
    await done(steps, 'welcome-email');
    const grant = on('access-grant');
    const trashed = await as(the.admin, 'task.trash', {
      recordId: grant,
      expectedRevision: await revisionOf(grant),
    });
    expect(trashed.status, JSON.stringify(trashed.body)).toBe(200);
    await done(steps, 'kickoff-call');
    expect(await openOn(grant)).toStrictEqual([]);
    const first = await as(the.admin, 'onboarding.step_result', {
      recordId: on('site-setup'),
      outcome: 'failed',
      result: 'first attempt failed',
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    // The restore parks the step, uncommitted, while the second failure stops the onboarding.
    const answers = await race(
      { name: 'task.restore', body: { batchId: detail(trashed)['batchId'] } },
      {
        name: 'onboarding.step_result',
        body: { recordId: on('site-setup'), outcome: 'failed', result: 'second attempt failed' },
      },
    );
    expect(answers.map((answer) => answer.status)).toStrictEqual([200, 200]);
    const [onboarding] = await the.controls.fixture.db.admin.execute<{ readonly state: string }>(
      `select o.state from public.onboardings o
         join public.onboarding_steps s on s.onboarding_id = o.id where s.task_id = $1`,
      [grant],
    );
    expect(onboarding?.state).toBe('stopped');
    expect(await openOn(grant)).toStrictEqual([]);
  });
});
