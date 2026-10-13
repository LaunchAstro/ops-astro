// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCredentialCommand } from '../../packages/core-commands/src/commands/credential-envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { readTaskWork } from '../../packages/core-commands/src/reads/proposals.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import {
  openSchedules,
  createTask,
  propose,
  asPerson,
  type Schedules,
} from '../runtime/schedules-harness.ts';

// eslint-disable-next-line max-lines-per-function -- one world, one case
describe.skipIf(databaseUrlFromEnvironment() === undefined)('a task read after a lock wait', () => {
  let s: Schedules;
  beforeAll(async () => {
    s = await openSchedules('gateafterwait', 100_000);
  });
  afterAll(async () => await s?.db.drop());

  // eslint-disable-next-line max-lines-per-function -- one held row, one wait, one read
  it('a task read after a credential row wait reports a gate that expired in the wait', async () => {
    const taskId = await createTask(s, 'expired gate canary');
    const proposal = await propose(s, taskId);
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, s.decider, 'write', undefined, false, 'credential');
    });
    const issued = await asPerson(s, {
      command: 'credential.issue',
      operationId: randomUUID(),
      scope: [{ collection: 'task', action: 'read' }],
      purpose: 'read after a credential lock wait',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    if (isCommandRefusal(issued)) throw new Error(issued.code);
    const credential = issued.detail['credential'];
    if (typeof credential !== 'string') throw new Error('no credential');
    await s.db.admin.execute(
      `update public.gates set expires_at = clock_timestamp() + interval '2 seconds' where id = $1`,
      [proposal['gateId']],
    );
    const held = await hold(
      s.db.appUrl,
      s.business,
      async (tx) =>
        await tx.query(
          'select id from public.agent_credentials where business_id = $1 and id = $2 for update',
          [s.business, issued.recordId],
        ),
    );
    const reader = connect(s.db.appUrl);
    let reading;
    try {
      reading = executeCredentialCommand(reader, s.business, { credential, now: new Date() }, {
        command: 'task.read',
        recordId: taskId,
      } as never);
      await waitingOn(s.db.admin, 'transactionid', 'agent_credentials');
      for (let attempt = 0; attempt < 500; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- polled until the gate's deadline passes
        const [clock] = await s.db.admin.execute<{ expired: boolean }>(
          'select expires_at <= clock_timestamp() as expired from public.gates where id = $1',
          [proposal['gateId']],
        );
        if (clock?.expired === true) break;
        if (attempt === 499) throw new Error('gate did not expire');
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
      expect(isCommandRefusal(answer)).toBe(false);
      const fresh = await s.db.app.withBusiness(
        s.business,
        async (tx) => await readTaskWork(tx, taskId),
      );
      expect(fresh.proposals[0]?.versions[0]?.gate?.expired).toBe(true);
      expect(JSON.stringify(answer)).toContain('"expired":true');
    } finally {
      await reader.close();
    }
  });
});
