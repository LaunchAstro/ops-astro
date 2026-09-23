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
//
// The second block is the narrowed half (ROOT-NARROWED-REPORT-RULING, T4 line
// 76 "a revoked/narrowed agent"): after `grant.revoke` takes the person's only
// write grant, the original agent's handback still answers
// `DELEGATION_NARROWED` and its report is retained, bound exactly as the
// retired path binds it. Both paths are run against the same executable
// controls: a second agent, another business, a forged credential, a wrong
// lease and a wrong fence retain nothing; a same-identity retry retains no
// second row; altered operands cannot reuse the receipt; a fault after the
// retained row rolls the row, the receipt and the audit back together.
//
// The third path is the narrowed agent nobody revoked (REVIEW-AGENT-BOUNDARY
// 62307d5 N1, ROOT-GRANT-EXPIRY-INTAKE-RULING). The person's write grant is
// issued with an expiry shorter than the lease, the delegation is minted
// against it at pickup, and the grant's deadline then passes: no `revoked_at`,
// no `authority_lost`, a delegation still live and unexpired. The handback
// answers `DELEGATION_NARROWED` from the authority check rather than the
// resolver, and the same controls hold. Read stays open, because the person
// still holds read; only write lapsed.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { createControls, detailOf, PROPOSAL, type Controls } from '../api/controls-fixture.ts';
import {
  ADMIN_ACTIONS,
  ADMIN_COLLECTIONS,
  enrolAgent,
  enrolCaller,
  type AgentIdentity,
} from '../acceptance/cast.ts';
import { PROPOSAL as ROLE_PROPOSAL } from '../acceptance/role-case-bodies.ts';
import type { Caller } from '../acceptance/world.ts';
import { createIdentWorld, type IdentWorld } from '../acceptance/ident-audit-cases.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { WHOLE_BUSINESS } from '../commands/fixture.ts';

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

interface LostWork {
  readonly approver: Caller;
  readonly agent: AgentIdentity;
  readonly taskId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly delegationId: string;
  readonly credential: string;
}

const lostBody = (
  x: LostWork,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  operationId: randomUUID(),
  leaseId: x.leaseId,
  fence: x.fence,
  outcome: 'completed',
  report: { wrote: 'finished after the authority went' },
  ...overrides,
});

describe.skipIf(serverUrl === undefined)('narrowed and retired agent report intake', () => {
  let w: IdentWorld;

  beforeAll(async () => {
    w = await createIdentWorld('narrowed_intake');
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  });

  const admin = async <T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly T[]> => await w.h.world.db.admin.execute<T>(sql, [...parameters]);
  const count = async (sql: string, parameters: readonly unknown[]): Promise<number> =>
    Number((await admin<{ n: string }>(sql, parameters))[0]?.n);

  /** The person's only task write, issued through the grant writer to end in five minutes. */
  async function issueShortWrite(approver: Caller): Promise<void> {
    const { world } = w.h;
    const issued = await world.db.app.withBusiness(
      world.alpha,
      async (tx) =>
        await issueGrant(tx, [], {
          subject: { kind: 'person', id: approver.personId as string },
          scope: WHOLE_BUSINESS,
          collection: 'task',
          action: 'write',
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
          parentGrantId: null,
          grantedByActorId: world.ada.actorId as string,
        }),
    );
    expect(issued.ok).toBe(true);
  }

  /**
   * A person approves their own work and a fresh agent picks it up.
   *
   * `shortWrite` issues the person's task write as the only one they hold,
   * through the grant writer, with an expiry five minutes out: shorter than the
   * default fifteen-minute lease the delegation is minted for, which pickup
   * does not clamp to it (`pickup.ts`, `delegations.ts` `mintDelegation`).
   */
  async function work(name: string, shortWrite = false): Promise<LostWork> {
    const { world } = w.h;
    const approver = await enrolCaller(world.db, world.alpha, 'alpha', name, {
      membership: true,
      actions: shortWrite ? ADMIN_ACTIONS.filter((action) => action !== 'write') : ADMIN_ACTIONS,
      collections: ADMIN_COLLECTIONS,
    });
    if (shortWrite) await issueShortWrite(approver);
    const agent = await enrolAgent(world.db, world.alpha, world.ada.actorId as string);
    const made = await w.person(approver, 'task.create', { fields: { title: `work ${name}` } });
    const proposed = await w.person(approver, 'task.propose', {
      recordId: made.body['recordId'],
      expectedRevision: made.body['revision'],
      ...ROLE_PROPOSAL,
    });
    const gate = proposed.body['detail'] as Record<string, unknown>;
    const decided = await w.person(approver, 'task.decide', {
      gateId: gate['gateId'],
      versionId: gate['versionId'],
      decision: 'approve',
      note: 'approved for the intake proof',
    });
    const reservationId = (decided.body['detail'] as Record<string, unknown>)['reservationId'];
    const picked = await w.agent(agent, 'task.pickup', { reservationId });
    expect(picked.code, picked.text).toBe('ok');
    const detail = picked.body['detail'] as Record<string, unknown>;
    return {
      approver,
      agent,
      taskId: String(detail['taskId']),
      leaseId: String(detail['leaseId']),
      fence: Number(detail['fence']),
      delegationId: String(detail['delegationId']),
      credential: String(detail['credential']),
    };
  }

  /** R-B: every live task write the approver holds, revoked through `grant.revoke`. */
  async function narrow(x: LostWork): Promise<void> {
    const grants = await admin<{ id: string }>(
      `select id from public.grants
        where business_id = $1 and subject_kind = 'person' and subject_id = $2
          and collection = 'task' and action = 'write' and revoked_at is null`,
      [w.h.world.alpha, x.approver.personId],
    );
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) {
      // eslint-disable-next-line no-await-in-loop -- through the owning route, one at a time
      const revoked = await w.person(w.h.world.ada, 'grant.revoke', { grantId: grant.id });
      expect(revoked.code, revoked.text).toBe('ok');
    }
    const cause = await admin<{ cause: string }>(
      `select revocation_cause as cause from public.delegations where id = $1`,
      [x.delegationId],
    );
    expect(cause[0]?.cause).toBe('authority_lost');
  }

  /** Plain expiry, the retired path's representative (the first block covers supersession). */
  async function expire(x: LostWork): Promise<void> {
    await admin(
      `update public.delegations set granted_at = now() - interval '2 hours',
                                   expires_at = now() - interval '1 second' where id = $1`,
      [x.delegationId],
    );
  }

  /**
   * N1: the person's short-lived write grant reaches its deadline, moved into
   * the past as `expire` moves a delegation's. Nothing is revoked, and the
   * delegation and lease stay live and unexpired.
   */
  async function lapse(x: LostWork): Promise<void> {
    const lapsed = await admin<{ id: string }>(
      `update public.grants set expires_at = now() - interval '1 second'
        where business_id = $1 and subject_kind = 'person' and subject_id = $2
          and collection = 'task' and action = 'write' and expires_at is not null
          and revoked_at is null
        returning id`,
      [w.h.world.alpha, x.approver.personId],
    );
    expect(lapsed).toHaveLength(1);
    const still = await admin<{ live: boolean; cause: string | null; lease: boolean }>(
      `select d.revoked_at is null and d.settled_at is null and d.expires_at > now() as live,
              d.revocation_cause as cause,
              (select l.expires_at > now() and l.released_at is null
                 from public.leases l where l.id = $2) as lease
         from public.delegations d where d.id = $1`,
      [x.delegationId, x.leaseId],
    );
    expect(still[0]).toStrictEqual({ live: true, cause: null, lease: true });
  }

  const PATHS = [
    {
      label: 'narrowed',
      code: 'DELEGATION_NARROWED',
      status: 403,
      lose: narrow,
      shortWrite: false,
      readCode: 'DELEGATION_NARROWED',
      otherLeaseCode: 'DELEGATION_NARROWED',
    },
    {
      label: 'retired',
      code: 'DELEGATION_NOT_LIVE',
      status: 401,
      lose: expire,
      shortWrite: false,
      readCode: 'DELEGATION_NOT_LIVE',
      otherLeaseCode: 'DELEGATION_NOT_LIVE',
    },
    // Still live, so the one-task ceiling answers first for another task's
    // lease, and read is still held.
    {
      label: 'grant-expired',
      code: 'DELEGATION_NARROWED',
      status: 403,
      lose: lapse,
      shortWrite: true,
      readCode: 'ok',
      otherLeaseCode: 'DELEGATION_OUT_OF_PURPOSE',
    },
  ] as const;

  const retained = async (leaseId: string): Promise<readonly Record<string, unknown>[]> =>
    await admin(
      `select disposition, refusal_code, fence::text as fence, outcome, report
         from public.handback_reports where lease_id = $1 order by created_at`,
      [leaseId],
    );
  const receipts = async (operationId: unknown): Promise<number> =>
    await count(`select count(*)::text as n from public.operations where operation_id = $1`, [
      operationId,
    ]);
  const refusals = async (operationId: unknown, code: string): Promise<number> =>
    await count(
      `select count(*)::text as n from public.audit_events
        where operation_id = $1 and outcome = 'refused' and refusal_code = $2`,
      [operationId, code],
    );

  /** Everything but the retained report: lease, hold, delegation, versions, gates, envelope. */
  async function protectedState(x: LostWork): Promise<string> {
    const rows = await admin<{ state: string }>(
      `select jsonb_build_object(
          'delegation', (select to_jsonb(d) from public.delegations d where d.id = $1),
          'leases', (select jsonb_agg(to_jsonb(l) order by l.fence) from public.leases l
                      where l.task_id = $2),
          'holds', (select jsonb_agg(to_jsonb(r) order by r.id) from public.reservations r
                     where r.id in (select reservation_id from public.leases where task_id = $2)),
          'versions', (select jsonb_agg(to_jsonb(v) order by v.id) from public.proposal_versions v
                        join public.proposal_lineages lin on lin.id = v.lineage_id
                       where lin.task_id = $2),
          'gates', (select count(*) from public.gates),
          'envelopes', (select jsonb_agg(to_jsonb(e) order by e.id) from public.task_envelopes e
                         where e.task_id = $2),
          'task', (select to_jsonb(t) from public.records t where t.id = $2),
          'live', (select count(*) from public.delegations
                    where revoked_at is null and settled_at is null)
        )::text as state`,
      [x.delegationId, x.taskId],
    );
    return String(rows[0]?.state);
  }

  for (const path of PATHS) {
    it(`${path.label}: one retained report, the refusal unchanged, nothing else moved`, async () => {
      const x = await work(`${path.label}_main`, path.shortWrite);
      await path.lose(x);
      const before = await protectedState(x);

      // Heartbeat and a read under the lost delegation retain nothing.
      const beat = await w.agent(
        x.agent,
        'task.heartbeat',
        { leaseId: x.leaseId, fence: x.fence },
        x.credential,
      );
      expect(beat.code, beat.text).toBe(path.code);
      const read = await w.agent(x.agent, 'task.read', { recordId: x.taskId }, x.credential);
      expect(read.code, read.text).toBe(path.readCode);
      expect(await retained(x.leaseId)).toHaveLength(0);

      const sent = lostBody(x);
      const answer = await w.agent(x.agent, 'task.handback', sent, x.credential);
      expect(answer.status, answer.text).toBe(path.status);
      expect(answer.code).toBe(path.code);
      expect(answer.text).not.toContain('finished after the authority went');
      expect(Object.keys(answer.body).toSorted()).toStrictEqual(Object.keys(beat.body).toSorted());
      const rows = await retained(x.leaseId);
      expect(rows).toEqual([
        {
          disposition: 'retained',
          refusal_code: path.code,
          fence: String(x.fence),
          outcome: 'completed',
          report: sent['report'],
        },
      ]);
      expect(await receipts(sent['operationId'])).toBe(1);
      expect(await refusals(sent['operationId'], path.code)).toBe(1);
      expect(await protectedState(x)).toBe(before);
      if (path.label !== 'retired') {
        // Durable R-B keeps its cause; natural expiry is given none.
        const cause = await admin<{ cause: string | null }>(
          `select revocation_cause as cause from public.delegations where id = $1`,
          [x.delegationId],
        );
        expect(cause[0]?.cause).toBe(path.label === 'narrowed' ? 'authority_lost' : null);
      }

      // The same identity replays its receipt and retains no second row.
      const replay = await w.agent(x.agent, 'task.handback', sent, x.credential);
      expect(replay.text).toBe(answer.text);
      expect(await retained(x.leaseId)).toHaveLength(1);
      expect(await receipts(sent['operationId'])).toBe(1);

      // Altered operands under that identity cannot reuse the receipt.
      const altered = await w.agent(
        x.agent,
        'task.handback',
        { ...sent, report: { wrote: 'something else' } },
        x.credential,
      );
      expect(altered.code).toBe('OPERATION_ID_REUSED');
      expect(await retained(x.leaseId)).toHaveLength(1);

      // A new valid identity is a new report, appended.
      const next = lostBody(x, { outcome: 'failed', report: { wrote: 'a second note' } });
      expect((await w.agent(x.agent, 'task.handback', next, x.credential)).code).toBe(path.code);
      expect((await retained(x.leaseId)).map((row) => row['outcome'])).toStrictEqual([
        'completed',
        'failed',
      ]);
      expect(await protectedState(x)).toBe(before);
    }, 120_000);

    it(`${path.label}: another agent, another business, a forged credential, a wrong lease or fence retain nothing`, async () => {
      const x = await work(`${path.label}_controls`, path.shortWrite);
      const other = await work(`${path.label}_other`, path.shortWrite);
      await path.lose(x);
      const before = await protectedState(x);
      const stranger = await enrolAgent(
        w.h.world.db,
        w.h.world.alpha,
        w.h.world.ada.actorId as string,
      );
      const forged = `${x.credential.slice(0, -4)}${x.credential.endsWith('0000') ? '1111' : '0000'}`;
      const tries = {
        stranger: await w.agent(stranger, 'task.handback', lostBody(x), x.credential),
        bravo: await w.agent(x.agent, 'task.handback', lostBody(x), x.credential, 'bravo'),
        foreign: await w.agent(
          x.agent,
          'task.handback',
          lostBody(x, { leaseId: w.foreign.picked.leaseId, fence: w.foreign.picked.fence }),
          x.credential,
        ),
        forged: await w.agent(x.agent, 'task.handback', lostBody(x), forged),
        lease: await w.agent(
          x.agent,
          'task.handback',
          lostBody(x, { leaseId: other.leaseId, fence: other.fence }),
          x.credential,
        ),
        unknownLease: await w.agent(
          x.agent,
          'task.handback',
          lostBody(x, { leaseId: randomUUID() }),
          x.credential,
        ),
        fence: await w.agent(
          x.agent,
          'task.handback',
          lostBody(x, { fence: x.fence + 1 }),
          x.credential,
        ),
      };
      expect(tries.stranger.code, tries.stranger.text).toBe('DELEGATION_NOT_LIVE');
      expect(tries.forged.code, tries.forged.text).toBe('DELEGATION_NOT_LIVE');
      expect(tries.bravo.code, tries.bravo.text).not.toBe(path.code);
      expect(tries.lease.code, tries.lease.text).toBe(path.otherLeaseCode);
      for (const key of ['foreign', 'unknownLease', 'fence'] as const) {
        expect(tries[key].code, `${key} ${tries[key].text}`).toBe(path.code);
      }
      expect(await retained(x.leaseId)).toHaveLength(0);
      expect(await retained(other.leaseId)).toHaveLength(0);
      expect(await retained(w.foreign.picked.leaseId)).toHaveLength(0);
      expect(await protectedState(x)).toBe(before);
    }, 120_000);

    it(`${path.label}: actualMinor 1 is the operand refusal, and nothing is retained`, async () => {
      // Sol 6 AUTHORITY-3. The restricted intake keeps an otherwise valid
      // report; a handback claiming spend is not one (API.md, every non-null
      // actualMinor is ACTUAL_EXPENDITURE_UNSUPPORTED), whatever its authority.
      const x = await work(`${path.label}_spend`, path.shortWrite);
      await path.lose(x);
      const before = await protectedState(x);
      const sent = lostBody(x, { actualMinor: 1 });
      const answer = await w.agent(x.agent, 'task.handback', sent, x.credential);
      console.log(
        `${path.label} actualMinor 1: ${answer.status} ${answer.code}, ` +
          `${(await retained(x.leaseId)).length} retained`,
      );
      expect({ status: answer.status, code: answer.code }).toStrictEqual({
        status: 422,
        code: 'ACTUAL_EXPENDITURE_UNSUPPORTED',
      });
      expect(await retained(x.leaseId)).toHaveLength(0);
      expect(await refusals(sent['operationId'], 'ACTUAL_EXPENDITURE_UNSUPPORTED')).toBe(1);
      expect(
        await count(`select count(*)::text as n from public.audit_events where operation_id = $1`, [
          sent['operationId'],
        ]),
      ).toBe(1);
      expect(await protectedState(x)).toBe(before);

      // A null actual is the same request as none, and is still retained.
      const valid = lostBody(x, { actualMinor: null });
      expect((await w.agent(x.agent, 'task.handback', valid, x.credential)).code).toBe(path.code);
      expect(await retained(x.leaseId)).toHaveLength(1);
    }, 120_000);

    it(`${path.label}: a fault after the retained row rolls it back with the receipt and the audit`, async () => {
      const x = await work(`${path.label}_fault`, path.shortWrite);
      await path.lose(x);
      const sent = lostBody(x);
      const marker = String(sent['operationId']);
      // The audit row is the last write of the refusal's transaction, after
      // the retained report and the register row. Failing it proves the three
      // commit together or not at all.
      await admin(
        `create or replace function public.test_fail_audit() returns trigger
           language plpgsql as $$
         begin
           if new.operation_id = '${marker}' then raise exception 'injected after retention'; end if;
           return new;
         end $$`,
      );
      await admin(
        `create trigger test_fail_audit before insert on public.audit_events
           for each row execute function public.test_fail_audit()`,
      );
      try {
        const answer = await w.agent(x.agent, 'task.handback', sent, x.credential);
        // A fault, not an answer: the server's plain 500.
        expect(answer.status, answer.text).toBe(500);
      } finally {
        await admin(`drop trigger test_fail_audit on public.audit_events`);
        await admin(`drop function public.test_fail_audit()`);
      }
      expect(await retained(x.leaseId)).toHaveLength(0);
      expect(await receipts(marker)).toBe(0);
      expect(
        await count(`select count(*)::text as n from public.audit_events where operation_id = $1`, [
          marker,
        ]),
      ).toBe(0);

      // The same request after the fault is the first real attempt.
      const again = await w.agent(x.agent, 'task.handback', sent, x.credential);
      expect(again.code).toBe(path.code);
      expect(await retained(x.leaseId)).toHaveLength(1);
    }, 120_000);
  }
});
