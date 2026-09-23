// SPDX-License-Identifier: AGPL-3.0-only
//
// The work controls through their owning operations: `task.cancel` reaching
// `cancelAndClassify`, `task.restart` opening a new lineage with provenance,
// and `task.heartbeat` renewing the current owner's lease.
//
// Contract ledger rows: "Existing run cancellation and authorised restart
// controls" and "Lease heartbeat / bounded unstarted recovery", with G05 (a
// restart is a distinct lineage and never reuses the old lease or hold) and
// W04 (recovery stays the owning operation's classifier; no timer grants
// authority). The request shapes are the ones L5-RESTART-PROOF-2's two cases
// send: cancel `{ recordId, lineageId, reason }`, restart
// `{ recordId, lineageId }`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { createControls, detailOf, type Controls } from './controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('task.cancel, task.restart and task.heartbeat', () => {
  let c: Controls;

  beforeAll(async () => {
    c = await createControls('ctlwk');
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  /** A task with an approved, unpicked reservation on a live lineage. */
  async function approvedLineage(purpose: string): Promise<{
    taskId: string;
    lineageId: string;
    reservationId: string;
  }> {
    const task = await c.createTask(`a task for ${purpose}`);
    const proposal = await c.propose(task.id, task.revision, purpose);
    const reservationId = await c.approve(proposal);
    return { taskId: task.id, lineageId: String(proposal['lineageId']), reservationId };
  }

  describe('task.cancel', () => {
    it('cancels the lineage, its hold becomes unclaimable, and the refused pickup is audited', async () => {
      const work = await approvedLineage('cancel_me');
      const body = { recordId: work.taskId, lineageId: work.lineageId, reason: 'no longer wanted' };
      const operationId = `cancel-${work.lineageId}`;
      const cancelled = await c.asPerson('task.cancel', { operationId, ...body });
      expect(cancelled.status).toBe(200);
      const detail = detailOf(cancelled);
      expect(detail['lineageId']).toBe(work.lineageId);
      expect(detail['reservations']).toStrictEqual([
        expect.objectContaining({ reservationId: work.reservationId, released: true }),
      ]);
      expect(
        await c.count(
          `select count(*)::text as n from public.proposal_lineages
            where id = $1 and state = 'cancelled' and terminal_reason = 'no longer wanted'`,
          [work.lineageId],
        ),
      ).toBe(1);

      // A byte-identical replay is the first answer and writes nothing.
      const replay = await c.asPerson('task.cancel', { operationId, ...body });
      expect(replay.body).toStrictEqual(cancelled.body);
      expect(
        await c.count(`select count(*)::text as n from public.operations where operation_id = $1`, [
          operationId,
        ]),
      ).toBe(1);

      const leases = `select count(*)::text as n from public.leases where task_id = $1`;
      const pickup = await c.asAgent('task.pickup', { reservationId: work.reservationId });
      expect(pickup.status).toBe(409);
      expect(pickup.body['code']).toBe('RESERVATION_NOT_CLAIMABLE');
      expect(await c.count(leases, [work.taskId])).toBe(0);
      expect(
        await c.count(
          `select count(*)::text as n from public.audit_events
            where command = 'task.pickup' and outcome = 'refused'
              and refusal_code = 'RESERVATION_NOT_CLAIMABLE'`,
          [],
        ),
      ).toBeGreaterThanOrEqual(1);

      // The lineage does not resume: a new version in it is refused.
      const resumed = await c.asPerson('task.propose', {
        recordId: work.taskId,
        expectedRevision: 1,
        lineageId: work.lineageId,
        purpose: 'cancel_me',
        maximumMinor: 100,
        currency: 'AUD',
        payload: {},
        step: { kind: 'compose', payload: {} },
      });
      expect(resumed.body['code']).toBe('LINEAGE_TERMINAL');
    });

    it('refuses a second cancellation, a lineage on another task, and a caller without write', async () => {
      const work = await approvedLineage('cancel_twice');
      const body = { recordId: work.taskId, lineageId: work.lineageId, reason: 'stop' };
      expect((await c.asPerson('task.cancel', body)).status).toBe(200);
      const twice = await c.asPerson('task.cancel', body);
      expect(twice.body['code']).toBe('LINEAGE_TERMINAL');

      const elsewhere = await approvedLineage('cancel_elsewhere');
      const other = await c.createTask('a task the lineage is not on');
      const crossed = await c.asPerson('task.cancel', {
        recordId: other.id,
        lineageId: elsewhere.lineageId,
        reason: 'wrong task',
      });
      expect(crossed.body['code']).toBe('LINEAGE_NOT_ON_TASK');

      const reader = await c.asPerson(
        'task.cancel',
        { recordId: elsewhere.taskId, lineageId: elsewhere.lineageId, reason: 'not mine' },
        c.reader,
      );
      expect(reader.status).toBe(403);
      expect(reader.body['code']).toBe('SCOPE_NOT_GRANTED');
    });
  });

  describe('task.restart', () => {
    it('opens a new lineage with provenance, a pending gate and no hold; the old one stays cancelled', async () => {
      const work = await approvedLineage('restart_me');
      await c.asPerson('task.cancel', {
        recordId: work.taskId,
        lineageId: work.lineageId,
        reason: 'restart it',
      });
      const operationId = `restart-${work.lineageId}`;
      const body = { operationId, recordId: work.taskId, lineageId: work.lineageId };
      const restarted = await c.asPerson('task.restart', body);
      expect(restarted.status).toBe(200);
      const detail = detailOf(restarted);
      const fresh = String(detail['lineageId']);
      expect(fresh).not.toBe(work.lineageId);
      expect(detail['version']).toBe(1);
      expect(detail['restartsLineageId']).toBe(work.lineageId);

      expect(
        await c.count(
          `select count(*)::text as n from public.proposal_lineages
            where id = $1 and restarts_lineage_id = $2 and state = 'live'`,
          [fresh, work.lineageId],
        ),
      ).toBe(1);
      expect(
        await c.count(
          `select count(*)::text as n from public.proposal_lineages where id = $1 and state = 'cancelled'`,
          [work.lineageId],
        ),
      ).toBe(1);
      expect(
        await c.count(
          `select count(*)::text as n from public.gates where id = $1 and state = 'pending'`,
          [detail['gateId']],
        ),
      ).toBe(1);
      expect(
        await c.count(
          `select count(*)::text as n from public.reservations res
             join public.proposal_versions v on v.id = res.version_id
            where v.lineage_id = $1`,
          [fresh],
        ),
      ).toBe(0);
      // The old hold stays released and is not reused.
      const pickup = await c.asAgent('task.pickup', { reservationId: work.reservationId });
      expect(pickup.body['code']).toBe('RESERVATION_NOT_CLAIMABLE');

      const replay = await c.asPerson('task.restart', body);
      expect(replay.body).toStrictEqual(restarted.body);
      expect(
        await c.count(
          `select count(*)::text as n from public.proposal_lineages where restarts_lineage_id = $1`,
          [work.lineageId],
        ),
      ).toBe(1);
    });

    it('restarts a rejected lineage, and refuses a live one and a second restart', async () => {
      const task = await c.createTask('a task whose proposal is rejected');
      const proposal = await c.propose(task.id, task.revision, 'reject_me');
      const rejected = await c.asPerson('task.decide', {
        gateId: proposal['gateId'],
        versionId: proposal['versionId'],
        decision: 'reject',
        note: 'no',
      });
      expect(rejected.status).toBe(200);
      const lineageId = String(proposal['lineageId']);
      const first = await c.asPerson('task.restart', { recordId: task.id, lineageId });
      expect(first.status).toBe(200);

      const again = await c.asPerson('task.restart', { recordId: task.id, lineageId });
      expect(again.status).toBe(409);
      expect(again.body['code']).toBe('TRANSITION_NOT_PERMITTED');

      const live = await c.asPerson('task.restart', {
        recordId: task.id,
        lineageId: detailOf(first)['lineageId'],
      });
      expect(live.status).toBe(409);
      expect(live.body['code']).toBe('TRANSITION_NOT_PERMITTED');
    });
  });

  describe('task.heartbeat', () => {
    it('renews the owner’s live lease, bounded, and moves its delegation with it', async () => {
      const work = await approvedLineage('beat_me');
      const picked = await c.pickup(work.reservationId, 60);
      const credential = String(picked['credential']);
      const beat = await c.asAgent(
        'task.heartbeat',
        { leaseId: picked['leaseId'], fence: picked['fence'], leaseSeconds: 600 },
        credential,
      );
      expect(beat.status).toBe(200);
      const renewed = Date.parse(String(detailOf(beat)['expiresAt']));
      expect(renewed).toBeGreaterThan(Date.parse(String(picked['expiresAt'])));
      expect(
        await c.count(
          `select count(*)::text as n from public.leases l
             join public.delegations d on d.id = l.delegation_id
            where l.id = $1 and l.expires_at = d.expires_at and l.expires_at > now() + interval '500 seconds'`,
          [picked['leaseId']],
        ),
      ).toBe(1);

      const tooLong = await c.asAgent(
        'task.heartbeat',
        { leaseId: picked['leaseId'], fence: picked['fence'], leaseSeconds: 100_000 },
        credential,
      );
      expect(tooLong.body['code']).toBe('FIELD_VALUE_INVALID');

      const staleFence = await c.asAgent(
        'task.heartbeat',
        { leaseId: picked['leaseId'], fence: Number(picked['fence']) + 1 },
        credential,
      );
      expect(staleFence.body['code']).toBe('LEASE_NOT_OWNED');

      // Settled by the handback: the delegation stops, so the heartbeat does too.
      const handed = await c.asAgent(
        'task.handback',
        {
          leaseId: picked['leaseId'],
          fence: picked['fence'],
          outcome: 'completed',
          actualMinor: null,
        },
        credential,
      );
      expect(handed.status).toBe(200);
      const late = await c.asAgent(
        'task.heartbeat',
        { leaseId: picked['leaseId'], fence: picked['fence'] },
        credential,
      );
      expect(late.status).toBe(401);
      expect(late.body['code']).toBe('DELEGATION_NOT_LIVE');
    });

    it('refuses an expired lease rather than reviving it', async () => {
      const work = await approvedLineage('beat_late');
      const picked = await c.pickup(work.reservationId, 1);
      await new Promise((resolve) => {
        setTimeout(resolve, 1_500);
      });
      const late = await c.asAgent(
        'task.heartbeat',
        { leaseId: picked['leaseId'], fence: picked['fence'] },
        String(picked['credential']),
      );
      expect(late.body['refused']).toBe(true);
      expect(['LEASE_EXPIRED', 'DELEGATION_NOT_LIVE']).toContain(late.body['code']);
      expect(
        await c.count(
          `select count(*)::text as n from public.leases where id = $1 and expires_at > now()`,
          [picked['leaseId']],
        ),
      ).toBe(0);
    });

    it('belongs to the agent: the person prefix refuses it', async () => {
      const answer = await c.asPerson('task.heartbeat', { leaseId: crypto.randomUUID(), fence: 1 });
      expect(answer.status).toBe(401);
      expect(answer.body['code']).toBe('AUTH_NO_AGENT_IDENTITY');
    });
  });
});
