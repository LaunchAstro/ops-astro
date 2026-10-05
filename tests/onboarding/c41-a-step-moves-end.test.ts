// SPDX-License-Identifier: AGPL-3.0-only
//
// Where a step's owed move ends and comes back (C41-A, CS-15.4): an onboarding
// that stops withdraws every open move of its steps, since none of them takes
// a result any more; and a person step that opened while its task was in the
// trash is parked with its owner when the task is restored.

import { describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { detail, useMoveWorld } from './c41-a-move-world.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, the two ends that share it
describe.skipIf(serverUrl === undefined)('C41-A step moves at stop and restore', () => {
  const { the, as, onboard, done, revisionOf, openOn } = useMoveWorld('c41aend');

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
    expect(await itemsOn(parked)).toStrictEqual(
      parked
        .toSorted()
        .map((task) => ({ task, recipient: the.admin.personId, work_state: 'withdrawn' })),
    );
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
    expect(await itemsOn([kickoff])).toStrictEqual([
      { task: kickoff, recipient: the.admin.personId, work_state: 'open' },
    ]);
  });
});
