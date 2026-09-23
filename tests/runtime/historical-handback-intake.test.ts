// SPDX-License-Identifier: AGPL-3.0-only
//
// A superseded agent's handback is retained, not refused unread (T4 lines 76
// and 78, runtime review C2, L6 W03).
//
// Supersession retires the original holder's lease and revokes its delegation
// (`propose.ts`, `recovery.ts` `retireWork`), so the agent's credential no
// longer resolves as live and the agent entry used to answer
// `DELEGATION_NOT_LIVE` before the report was ever read. T4 keeps that work:
// a restricted evidence-only intake, bound to the historical actor and lease,
// appends one unaccepted `handback_reports` row and still answers the refusal.
// Nothing else moves: not V2, not its gate, not the hold, not the lease, not
// the delegation.
//
// Every binding is exact. Another lease, another fence, an unknown credential
// and a live credential for other work keep the refusal they had and retain
// nothing. A settled handback's replay stays the replay; a new late report
// after it is its own retained row.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { createControls, detailOf, PROPOSAL, type Controls } from '../api/controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Picked {
  readonly taskId: string;
  readonly lineageId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly delegationId: string;
  readonly credential: string;
}

const handbackBody = (work: Picked, overrides: Record<string, unknown> = {}) => ({
  operationId: randomUUID(),
  leaseId: work.leaseId,
  fence: work.fence,
  outcome: 'completed',
  report: { wrote: 'a draft of V1 finished after V2 was proposed' },
  ...overrides,
});

describe.skipIf(serverUrl === undefined)('historical agent handback intake over HTTP', () => {
  let c: Controls;

  beforeAll(async () => {
    c = await createControls('hhbi');
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  async function pickedUp(title: string): Promise<Picked> {
    const task = await c.createTask(title);
    const proposal = await c.propose(task.id, task.revision, `hist_${randomUUID().slice(0, 8)}`);
    const picked = await c.pickup(await c.approve(proposal));
    return {
      taskId: task.id,
      lineageId: String(proposal['lineageId']),
      leaseId: String(picked['leaseId']),
      fence: Number(picked['fence']),
      delegationId: String(picked['delegationId']),
      credential: String(picked['credential']),
    };
  }

  /** A person proposes V2 in V1's lineage, which retires the agent's work. */
  async function supersede(work: Picked): Promise<Record<string, unknown>> {
    const revision = await c.fixture.db.admin.execute<{ readonly revision: string }>(
      `select revision::text as revision from public.records where id = $1`,
      [work.taskId],
    );
    const answer = await c.asPerson('task.propose', {
      recordId: work.taskId,
      expectedRevision: Number(revision[0]?.revision),
      ...PROPOSAL,
      purpose: `v2_${randomUUID().slice(0, 8)}`,
      lineageId: work.lineageId,
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return detailOf(answer);
  }

  /** Everything the intake must leave alone, read on the administrative connection. */
  async function stateOf(work: Picked): Promise<string> {
    const rows = await c.fixture.db.admin.execute<{ readonly state: string }>(
      `select jsonb_build_object(
          'delegation', (select to_jsonb(d) from public.delegations d where d.id = $1),
          'leases', (select jsonb_agg(to_jsonb(l) order by l.fence)
                       from public.leases l where l.task_id = $2),
          'reservations', (select jsonb_agg(to_jsonb(r) order by r.id)
                             from public.reservations r
                             join public.planned_runs run on run.id = r.run_id
                            where run.lineage_id = $3),
          'versions', (select jsonb_agg(to_jsonb(v) order by v.id)
                         from public.proposal_versions v where v.lineage_id = $3),
          'gates', (select jsonb_agg(to_jsonb(g) order by g.id) from public.gates g
                      join public.proposal_versions v on v.id = g.version_id
                     where v.lineage_id = $3),
          'envelopes', (select jsonb_agg(to_jsonb(e) order by e.id) from public.task_envelopes e
                          where e.task_id = $2),
          'task', (select to_jsonb(t) from public.records t where t.id = $2),
          'delegations', (select count(*) from public.delegations),
          'live', (select count(*) from public.delegations
                    where revoked_at is null and settled_at is null)
        )::text as state`,
      [work.delegationId, work.taskId, work.lineageId],
    );
    return String(rows[0]?.state);
  }

  async function reportsFor(leaseId: string): Promise<
    readonly {
      readonly disposition: string;
      readonly refusal_code: string | null;
      readonly fence: string;
      readonly report: unknown;
    }[]
  > {
    return await c.fixture.db.admin.execute(
      `select disposition, refusal_code, fence::text as fence, report
         from public.handback_reports where lease_id = $1 order by created_at`,
      [leaseId],
    );
  }

  const refusedAudits = async (operationId: string): Promise<number> =>
    await c.count(
      `select count(*)::text as n from public.audit_events
        where operation_id = $1 and command = 'task.handback' and outcome = 'refused'`,
      [operationId],
    );

  it('retains the superseded agent’s report once and still refuses, leaving V2 and the hold alone', async () => {
    const work = await pickedUp('an agent superseded mid-work');
    await supersede(work);
    const before = await stateOf(work);

    const body = handbackBody(work);
    const answer = await c.asAgent('task.handback', body, work.credential);
    expect(answer.status, JSON.stringify(answer.body)).toBe(401);
    expect(answer.body['code']).toBe('DELEGATION_NOT_LIVE');

    const reports = await reportsFor(work.leaseId);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.disposition).toBe('retained');
    expect(reports[0]?.refusal_code).toBe('DELEGATION_NOT_LIVE');
    expect(Number(reports[0]?.fence)).toBe(work.fence);
    expect(reports[0]?.report).toStrictEqual(body.report);
    expect(await refusedAudits(body.operationId)).toBe(1);
    expect(await stateOf(work)).toBe(before);
  });

  it('retains nothing for a wrong fence, another lease or an unknown credential', async () => {
    const work = await pickedUp('an agent superseded, then misaddressed');
    await supersede(work);
    const other = await pickedUp('an unrelated live task');
    const before = await stateOf(work);

    const tries = [
      { body: handbackBody(work, { fence: work.fence + 1 }), credential: work.credential },
      { body: handbackBody(work, { leaseId: other.leaseId }), credential: work.credential },
      { body: handbackBody(work, { leaseId: randomUUID() }), credential: work.credential },
      { body: handbackBody(work), credential: randomUUID() },
    ];
    for (const attempt of tries) {
      // eslint-disable-next-line no-await-in-loop -- one after another, each counted
      const answer = await c.asAgent('task.handback', attempt.body, attempt.credential);
      expect(answer.status, JSON.stringify(answer.body)).toBe(401);
      expect(answer.body['code']).toBe('DELEGATION_NOT_LIVE');
      // eslint-disable-next-line no-await-in-loop
      expect(await refusedAudits(attempt.body.operationId)).toBe(1);
    }
    expect(await reportsFor(work.leaseId)).toHaveLength(0);
    expect(await reportsFor(other.leaseId)).toHaveLength(0);
    expect(await stateOf(work)).toBe(before);

    // A live credential for other work presenting the retired lease is that
    // work's own ceiling, not a historical intake.
    const crossed = await c.asAgent('task.handback', handbackBody(work), other.credential);
    expect(crossed.body['code']).toBe('DELEGATION_OUT_OF_PURPOSE');
    expect(await reportsFor(work.leaseId)).toHaveLength(0);
    expect(await stateOf(work)).toBe(before);
  });

  it('takes the same path for a naturally expired credential, and settles nothing', async () => {
    const work = await pickedUp('an agent whose delegation ran out');
    await c.fixture.db.admin.execute(
      `update public.delegations set granted_at = now() - interval '2 hours',
                                   expires_at = now() - interval '1 second' where id = $1`,
      [work.delegationId],
    );
    const before = await stateOf(work);
    const body = handbackBody(work);
    const answer = await c.asAgent('task.handback', body, work.credential);
    expect(answer.status, JSON.stringify(answer.body)).toBe(401);
    expect(answer.body['code']).toBe('DELEGATION_NOT_LIVE');
    const reports = await reportsFor(work.leaseId);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.disposition).toBe('retained');
    expect(await refusedAudits(body.operationId)).toBe(1);
    expect(await stateOf(work)).toBe(before);
  });

  it('keeps a settled handback’s replay apart from a new late report', async () => {
    const work = await pickedUp('an agent that hands back, then reports again');
    const settled = handbackBody(work);
    const first = await c.asAgent('task.handback', settled, work.credential);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(await reportsFor(work.leaseId)).toHaveLength(1);

    const replay = await c.asAgent('task.handback', settled, work.credential);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body).toStrictEqual(first.body);
    expect(await reportsFor(work.leaseId)).toHaveLength(1);

    const before = await stateOf(work);
    const late = handbackBody(work, { report: { wrote: 'an afterthought' } });
    const answer = await c.asAgent('task.handback', late, work.credential);
    expect(answer.status, JSON.stringify(answer.body)).toBe(401);
    expect(answer.body['code']).toBe('DELEGATION_NOT_LIVE');
    const reports = await reportsFor(work.leaseId);
    expect(reports.map((row) => row.disposition)).toStrictEqual(['settled', 'retained']);
    expect(await refusedAudits(late.operationId)).toBe(1);
    expect(await stateOf(work)).toBe(before);
  });
});
