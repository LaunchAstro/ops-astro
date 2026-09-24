// SPDX-License-Identifier: AGPL-3.0-only
//
// FR2-PROPOSE continuation, left-open item 4: does any caller reach
// `refuseRestart`'s LINEAGE_NOT_ON_TASK in `core-runtime/src/propose.ts`,
// whose reason names the other task's id?
//
// `restartsLineageId` is set only by `restart.ts`, and `restart` is called only
// by `task.restart` (`tasks-controls.ts` `restartOnTask`), after
// `lineageOnTask` has compared the lineage's task with the task named and
// refused a mismatch in constant words. A lineage's `task_id` is never
// updated. So the attempt below, a restart naming a sibling task's rejected
// lineage, is answered by that guard and carries neither id.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  approveBody,
  asPerson,
  codeOf,
  createTask,
  freshPurpose,
  openSchedules,
  propose,
  scalar,
  type Schedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/final-r2-fr2-propose-restart: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

describe.skipIf(serverUrl === undefined)('task.restart naming another task’s lineage', () => {
  let s: Schedules;

  beforeAll(async () => {
    s = await openSchedules('fr2_propose_restart', 1_000_000);
  }, 90_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it('is refused by the command guard, naming neither task nor lineage', async () => {
    const own = await createTask(s, 'the task the caller restarts on');
    const other = await createTask(s, 'a sibling task whose lineage was rejected');
    const proposal = await propose(s, other, { purpose: freshPurpose() });
    const lineageId = String(proposal['lineageId']);
    const rejected = await asPerson(s, { ...approveBody(proposal), decision: 'reject' });
    expect(codeOf(rejected)).toBe('applied');
    const lineages = async () =>
      await scalar(
        s,
        `select count(*)::text as n from public.proposal_lineages where business_id = $1`,
        [s.business],
      );
    const before = await lineages();

    const answer = await asPerson(s, {
      command: 'task.restart',
      operationId: randomUUID(),
      recordId: own,
      lineageId,
    });

    expect(answer).toMatchObject({
      refused: true,
      code: 'LINEAGE_NOT_ON_TASK',
      names: ['lineageId'],
      fixes: ['Name the task the lineage was opened on.'],
    });
    const serialised = JSON.stringify(answer);
    expect(serialised).not.toContain(other);
    expect(serialised).not.toContain(lineageId);
    expect(await lineages()).toBe(before);
  }, 60_000);
});
