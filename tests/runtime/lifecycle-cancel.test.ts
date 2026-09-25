// SPDX-License-Identifier: AGPL-3.0-only
//
// F2 (runtime review at 4757d72): cancellation closes the work authority it
// ends, not only the lease.
//
// T5, TRANSACTION-CONTRACT line 82: the owning run-cancel control "releases
// the live lease and revokes the delegation", and because this head never
// dispatches, "its ordinary cancellation completes as cancelled". Before this
// suite the lease was released and the hold classified, while the agent's
// delegation stayed live and the run stayed `claimed`: the cancelled agent
// could still comment on the task, and the same agent picking up the
// restarted lineage met `DELEGATION_ALREADY_LIVE` from its own dead work.
//
// Every step goes through the HTTP command entry the product runs.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { createControls, detailOf, type Controls } from '../api/controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('cancellation closes the delegation and the run', () => {
  let c: Controls;

  beforeAll(async () => {
    c = await createControls('lccan');
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  async function pickedUp(purpose: string): Promise<{
    taskId: string;
    lineageId: string;
    runId: string;
    picked: Record<string, unknown>;
  }> {
    const task = await c.createTask(`a task for ${purpose}`);
    const proposal = await c.propose(task.id, task.revision, purpose);
    const reservationId = await c.approve(proposal);
    const picked = await c.pickup(reservationId);
    return {
      taskId: task.id,
      lineageId: String(proposal['lineageId']),
      runId: String(proposal['runId']),
      picked,
    };
  }

  it('revokes the delegation, ends the run as cancelled, and the agent can no longer comment', async () => {
    const work = await pickedUp('cancel_closes');
    const credential = String(work.picked['credential']);

    // The agent's own comment works while the work is live: the control case.
    const before = await c.asAgent(
      'task.comment',
      { recordId: work.taskId, body: 'working on it', audience: 'internal' },
      credential,
    );
    expect(before.status).toBe(200);

    const cancelled = await c.asPerson('task.cancel', {
      recordId: work.taskId,
      lineageId: work.lineageId,
      reason: 'the client withdrew',
    });
    expect(cancelled.status).toBe(200);
    expect(detailOf(cancelled)['state']).toBe('cancelled');

    expect(
      await c.count(
        `select count(*)::text as n from public.delegations d
           join public.leases l on l.delegation_id = d.id
          where l.id = $1 and d.revoked_at is not null`,
        [work.picked['leaseId']],
      ),
    ).toBe(1);
    expect(
      await c.count(
        `select count(*)::text as n from public.planned_runs where id = $1 and state = 'cancelled'`,
        [work.runId],
      ),
    ).toBe(1);
    // History kept: the lineage row, its reason and the released lease remain.
    expect(
      await c.count(
        `select count(*)::text as n from public.leases where id = $1 and state = 'released'`,
        [work.picked['leaseId']],
      ),
    ).toBe(1);

    const comments = `select count(*)::text as n from public.records r
       join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
      where t.key = 'task_comment'`;
    const written = await c.count(comments, []);
    const after = await c.asAgent(
      'task.comment',
      { recordId: work.taskId, body: 'still here', audience: 'internal' },
      credential,
    );
    expect(after.status).toBe(401);
    expect(after.body['code']).toBe('DELEGATION_NOT_LIVE');
    expect(await c.count(comments, [])).toBe(written);
  });

  it('lets the same agent pick up the restarted lineage without DELEGATION_ALREADY_LIVE', async () => {
    const work = await pickedUp('restart_same_agent');
    const cancelled = await c.asPerson('task.cancel', {
      recordId: work.taskId,
      lineageId: work.lineageId,
      reason: 'start again',
    });
    expect(cancelled.status).toBe(200);

    const restarted = await c.asPerson('task.restart', {
      recordId: work.taskId,
      lineageId: work.lineageId,
    });
    expect(restarted.status).toBe(200);
    const reservationId = await c.approve(detailOf(restarted));

    const again = await c.asAgent('task.pickup', { reservationId });
    expect(again.body['code']).toBeUndefined();
    expect(again.status).toBe(200);
  });
});
