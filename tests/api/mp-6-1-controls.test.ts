// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-1, the run controls through the real boundary and a fresh Postgres: no
// work goes out before its gate, each change is recorded, and `task.cancel`
// and `task.restart` take `gate:decide`, which an agent never holds. The
// checks are in `mp-6-1-checks.test.ts`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { Member } from '../commands/fixture.ts';
import type { Controls } from './controls-fixture.ts';
import { checksWorld, pickedUpOn } from './mp-6-1-checks-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one business, the run controls on it
describe.skipIf(serverUrl === undefined)('MP-6-1 checks and run controls', () => {
  let c: Controls;
  let writer: Member;

  beforeAll(async () => {
    ({ c, writer } = await checksWorld('mp_6_1_controls'));
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  const pickedUp = async (purpose: string) => await pickedUpOn(c, purpose);

  describe('MP-6-1 gate before effect', () => {
    it('no work goes out on an undecided version, nor on one a newer version replaced', async () => {
      const pickups = `select count(*)::text as n from public.leases where task_id = $1`;
      // Undecided: nothing is queued and nothing can be picked up.
      const task = await c.createTask('a proposal nobody has decided');
      const proposal = await c.propose(task.id, task.revision, 'undecided_work');
      const queue = await c.asAgent('task.queue', {});
      expect(JSON.stringify(queue.body)).not.toContain(task.id);
      expect(await c.count(pickups, [task.id])).toBe(0);

      // Stale: v1 approved, then v2 replaces it before anyone picks v1 up.
      const approvedTask = await c.createTask('a version replaced after its approval');
      const v1 = await c.propose(approvedTask.id, approvedTask.revision, 'replaced_work');
      const reservationId = await c.approve(v1);
      const read = await c.asPerson('task.read', { recordId: approvedTask.id });
      const revision = Number((read.body['task'] as { revision: number }).revision);
      const v2 = await c.asPerson('task.propose', {
        recordId: approvedTask.id,
        expectedRevision: revision,
        lineageId: v1['lineageId'],
        purpose: 'replaced_work',
        maximumMinor: 2_500,
        currency: 'AUD',
        payload: { instruction: 'the second version' },
        step: { kind: 'compose', payload: {} },
      });
      expect(v2.status, JSON.stringify(v2.body)).toBe(200);
      const stale = await c.asAgent('task.pickup', { reservationId });
      expect(stale.status).toBe(409);
      expect(stale.body['code']).toBe('RESERVATION_NOT_CLAIMABLE');
      expect(await c.count(pickups, [approvedTask.id])).toBe(0);

      // And the stale gate itself cannot be decided on the old version.
      const late = await c.asPerson('task.decide', {
        gateId: proposal['gateId'],
        versionId: v1['versionId'],
        decision: 'approve',
        note: 'the wrong version',
      });
      expect(late.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('MP-6-1 records', () => {
    it('each change is recorded, and the audited ones join the chain', async () => {
      const work = await pickedUp('recorded_changes');
      const checkId = 'check-recorded';
      const checked = await c.asAgent(
        'task.check',
        {
          operationId: checkId,
          leaseId: work.leaseId,
          fence: work.fence,
          name: 'spelling',
          outcome: 'passed',
        },
        work.credential,
      );
      expect(checked.status).toBe(200);
      const audited = `select count(*)::text as n from public.audit_events
                        where command = $1 and outcome = 'applied' and operation_id = $2`;
      expect(await c.count(audited, ['task.check', checkId])).toBe(1);

      const task = await c.createTask('a run that is cancelled on the record');
      const proposal = await c.propose(task.id, task.revision, 'cancel_on_record');
      const cancelId = 'cancel-recorded';
      const cancelled = await c.asPerson('task.cancel', {
        operationId: cancelId,
        recordId: task.id,
        lineageId: proposal['lineageId'],
        reason: 'recorded',
      });
      expect(cancelled.status).toBe(200);
      expect(await c.count(audited, ['task.cancel', cancelId])).toBe(1);
      const restartId = 'restart-recorded';
      const restarted = await c.asPerson('task.restart', {
        operationId: restartId,
        recordId: task.id,
        lineageId: proposal['lineageId'],
      });
      expect(restarted.status).toBe(200);
      expect(await c.count(audited, ['task.restart', restartId])).toBe(1);
    });
  });

  describe('MP-6-1 refusal gate:decide', () => {
    it('refuses cancel and restart to a person holding write without decide, nothing changed', async () => {
      const task = await c.createTask('a run a writer may not stop');
      const proposal = await c.propose(task.id, task.revision, 'writer_cannot_cancel');
      await c.approve(proposal);
      const lineageId = String(proposal['lineageId']);
      const cancel = await c.asPerson(
        'task.cancel',
        { recordId: task.id, lineageId, reason: 'a writer tries' },
        writer,
      );
      expect(cancel.status).toBe(403);
      const live = `select count(*)::text as n from public.proposal_lineages where id = $1 and state = 'live'`;
      expect(await c.count(live, [lineageId])).toBe(1);

      // The holder of decide cancels it; then the writer may not restart it.
      expect(
        (await c.asPerson('task.cancel', { recordId: task.id, lineageId, reason: 'stopped' }))
          .status,
      ).toBe(200);
      const restart = await c.asPerson('task.restart', { recordId: task.id, lineageId }, writer);
      expect(restart.status).toBe(403);
      expect(
        await c.count(
          `select count(*)::text as n from public.proposal_lineages where restarts_lineage_id = $1`,
          [lineageId],
        ),
      ).toBe(0);
      const restarted = await c.asPerson('task.restart', { recordId: task.id, lineageId });
      expect(restarted.status).toBe(200);
    });

    it('refuses the agent cancelling the run it works, whatever it holds', async () => {
      const work = await pickedUp('agent_cannot_cancel');
      const answer = await c.asAgent(
        'task.cancel',
        { recordId: work.taskId, lineageId: work.lineageId, reason: 'the agent tries' },
        work.credential,
      );
      expect(answer.status).toBeGreaterThanOrEqual(400);
      expect(
        await c.count(
          `select count(*)::text as n from public.proposal_lineages where id = $1 and state = 'live'`,
          [work.lineageId],
        ),
      ).toBe(1);
    });
  });
});
