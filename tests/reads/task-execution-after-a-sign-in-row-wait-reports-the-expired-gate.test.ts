// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { readTaskExecution } from '../../packages/core-commands/src/reads/execution.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import {
  openSchedules,
  createTask,
  propose,
  type Schedules,
} from '../runtime/schedules-harness.ts';

// eslint-disable-next-line max-lines-per-function -- one world, one case
describe.skipIf(databaseUrlFromEnvironment() === undefined)('execution after a wait', () => {
  let s: Schedules;
  beforeAll(async () => {
    s = await openSchedules('execgatewait', 100_000);
  }, 120_000);
  afterAll(async () => {
    await s?.db.drop();
  });

  // eslint-disable-next-line max-lines-per-function -- one held row, one wait, one read
  it('task execution after an authentication row wait reports the expired gate', async () => {
    const taskId = await createTask(s, 'expired gate canary');
    const proposal = await propose(s, taskId);
    await s.db.admin.execute(
      "update public.gates set expires_at = clock_timestamp() + interval '2 seconds' where id = $1",
      [proposal['gateId']],
    );
    const held = await hold(
      s.db.appUrl,
      s.business,
      async (tx) =>
        await tx.query(
          'select id from public.actors where business_id = $1 and id = $2 for update',
          [s.business, s.decider.actorId],
        ),
    );
    const reader = connect(s.db.appUrl);
    const reading = executeRead(reader, s.business, s.decider.presented, {
      read: 'task.execution',
      recordId: taskId,
      cursor: 0,
    });
    try {
      await waitingOn(s.db.admin, 'transactionid', 'authentication_attempts');
      for (let attempt = 0; attempt < 500; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- polled until the deadline passes
        // eslint-disable-next-line no-await-in-loop -- polled until the deadline passes
        const [clock] = await s.db.admin.execute<{ expired: boolean }>(
          'select expires_at <= clock_timestamp() as expired from public.gates where id = $1',
          [proposal['gateId']],
        );
        if (clock?.expired === true) break;
        if (attempt === 499) throw new Error('gate did not expire');
        // eslint-disable-next-line no-await-in-loop -- one poll at a time
        // eslint-disable-next-line no-await-in-loop -- one poll at a time
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
    } finally {
      await held.letGo();
    }
    try {
      const answer = await reading;
      expect(isCommandRefusal(answer) ? answer : undefined).toBeUndefined();
      const fresh = await s.db.app.withBusiness(
        s.business,
        async (tx) => await readTaskExecution(tx, taskId, 0),
      );
      expect(JSON.stringify(fresh)).toContain('"outcome":"expired"');
      expect(JSON.stringify(answer)).toContain('"outcome":"expired"');
    } finally {
      await reader.close();
    }
  });
});
