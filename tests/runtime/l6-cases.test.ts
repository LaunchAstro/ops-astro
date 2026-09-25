// SPDX-License-Identifier: AGPL-3.0-only
//
// L6 G04, G05 and W05, each through the production command entry on a real
// database (`schedules-harness.ts`).
//
// - **G04.** A held, unleased reservation whose version a real `task.propose`
//   has superseded is not claimable afresh. `pickup-replay-lost-response`
//   superseded the version by an administrative update and only replayed.
// - **G05, root ruling 3.** One restart continuation per terminal parent: the
//   same restart identity returns the same child, a different identity on the
//   already-restarted parent is refused and audited, and the child, once
//   terminal, restarts in its own right.
// - **G05, root ruling 4.** A parentless `task.propose` beside a rejected (or
//   cancelled) lineage is a fresh proposal with no restart provenance. The old
//   lineage, its gate, its hold and its lease stay terminal.
// - **W05.** An approval whose envelope has no room, under a cap that has
//   plenty, is `BUDGET_UNAVAILABLE` and not `BUDGET_EXHAUSTED`, and writes
//   nothing but its refused audit row.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  appliedDetail,
  approve,
  approveBody,
  asAgent,
  asPerson,
  codeOf,
  createTask,
  freshPurpose,
  pickup,
  propose,
  rows,
  scalar,
  type Body,
  type Detail,
  type Schedules,
  openSchedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/l6-cases: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const rejectBody = (proposal: Detail): Body => ({
  command: 'task.decide',
  operationId: randomUUID(),
  gateId: proposal['gateId'],
  versionId: proposal['versionId'],
  decision: 'reject',
  note: 'not this',
});

const restartBody = (taskId: string, lineageId: unknown): Body => ({
  command: 'task.restart',
  operationId: randomUUID(),
  recordId: taskId,
  lineageId,
});

describe.skipIf(serverUrl === undefined)('L6 cases: G04, G05 and W05', () => {
  let s: Schedules;

  beforeAll(async () => {
    s = await openSchedules('l6_cases', 1_000_000);
  }, 90_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  const count = async (text: string, parameters: readonly unknown[]): Promise<number> =>
    await scalar(s, text, [s.business, ...parameters]);

  /** Every audit row an operation left, as `outcome/code`. */
  const auditOf = async (operationId: unknown): Promise<readonly string[]> =>
    (
      await rows<{ readonly outcome: string; readonly code: string | null }>(
        s,
        `select outcome, refusal_code as code from public.audit_events
          where business_id = $1 and operation_id = $2 order by seq`,
        [s.business, operationId],
      )
    ).map((row) => `${row.outcome}/${row.code ?? ''}`);

  /** The runtime rows a claim or a hold would touch, for a before/after comparison. */
  async function runtimeState(taskId: string): Promise<unknown> {
    return {
      leases: await rows(
        s,
        `select id, state, fence, expires_at from public.leases
          where business_id = $1 and task_id = $2 order by id`,
        [s.business, taskId],
      ),
      delegations: await rows(
        s,
        `select id, revoked_at, settled_at, expires_at from public.delegations
          where business_id = $1 order by id`,
        [s.business],
      ),
      holds: await rows(
        s,
        `select r.id, r.state, r.lease_id, r.classified_cause, r.held_minor
           from public.reservations r
           join public.task_envelopes e on e.business_id = r.business_id and e.id = r.envelope_id
          where r.business_id = $1 and e.task_id = $2 order by r.id`,
        [s.business, taskId],
      ),
      envelopes: await rows(
        s,
        `select id, state, maximum_minor, held_minor, actual_minor from public.task_envelopes
          where business_id = $1 and task_id = $2 order by id`,
        [s.business, taskId],
      ),
      decisions: await rows(
        s,
        `select d.id from public.gate_decisions d
           join public.proposal_lineages l on l.business_id = d.business_id and l.id = d.lineage_id
          where d.business_id = $1 and l.task_id = $2 order by d.id`,
        [s.business, taskId],
      ),
    };
  }

  const lineage = async (
    id: unknown,
  ): Promise<{ readonly state: string; readonly restarts: string | null } | undefined> =>
    (
      await rows<{ readonly state: string; readonly restarts: string | null }>(
        s,
        `select state, restarts_lineage_id as restarts from public.proposal_lineages
          where business_id = $1 and id = $2`,
        [s.business, id],
      )
    )[0];

  const gateState = async (id: unknown): Promise<string | undefined> =>
    (
      await rows<{ readonly state: string }>(
        s,
        `select state from public.gates where business_id = $1 and id = $2`,
        [s.business, id],
      )
    )[0]?.state;

  async function reject(proposal: Detail): Promise<void> {
    appliedDetail(await asPerson(s, rejectBody(proposal)), 'task.decide reject');
  }

  const childrenOf = async (parent: unknown): Promise<number> =>
    await count(
      `select count(*)::text as n from public.proposal_lineages
        where business_id = $1 and restarts_lineage_id = $2`,
      [parent],
    );

  it('G04: a held reservation whose version a real proposal superseded is not claimed afresh', async () => {
    const taskId = await createTask(s, 'approved, held, then proposed again');
    const purpose = freshPurpose();
    const v1 = await propose(s, taskId, { purpose });
    const decision = await approve(s, v1);
    const r1 = decision['reservationId'];
    const v2 = await propose(s, taskId, { purpose, lineageId: String(v1['lineageId']) });
    expect(v2['lineageId']).toBe(v1['lineageId']);
    expect(v2['versionId']).not.toBe(v1['versionId']);

    const before = await runtimeState(taskId);
    const operationId = randomUUID();
    const refused = await asAgent(s, {
      command: 'task.pickup',
      operationId,
      reservationId: r1,
      leaseSeconds: 600,
    });
    expect(codeOf(refused)).toBe('RESERVATION_NOT_CLAIMABLE');
    expect(await runtimeState(taskId)).toStrictEqual(before);
    expect(
      await count(
        `select count(*)::text as n from public.leases where business_id = $1 and task_id = $2`,
        [taskId],
      ),
    ).toBe(0);
    expect(await auditOf(operationId)).toStrictEqual(['refused/RESERVATION_NOT_CLAIMABLE']);
  });

  it('G05 ruling 3: one continuation per terminal parent, and a terminal child restarts in turn', async () => {
    const taskId = await createTask(s, 'a proposal rejected, then restarted');
    const parent = await propose(s, taskId, { purpose: freshPurpose() });
    await reject(parent);

    const body = restartBody(taskId, parent['lineageId']);
    const child = appliedDetail(await asPerson(s, body), 'task.restart');
    expect(child['restartsLineageId']).toBe(parent['lineageId']);

    // The same identity, retried: the same child, and still only one.
    const retried = appliedDetail(await asPerson(s, body), 'task.restart retried');
    expect(retried).toStrictEqual(child);
    expect(await childrenOf(parent['lineageId'])).toBe(1);

    // A different identity against the already-restarted parent.
    const second = restartBody(taskId, parent['lineageId']);
    expect(codeOf(await asPerson(s, second))).toBe('TRANSITION_NOT_PERMITTED');
    expect(await auditOf(second['operationId'])).toStrictEqual([
      'refused/TRANSITION_NOT_PERMITTED',
    ]);
    expect(await childrenOf(parent['lineageId'])).toBe(1);

    // The old rejection stays terminal under both.
    expect(await lineage(parent['lineageId'])).toStrictEqual({ state: 'rejected', restarts: null });
    expect(await gateState(parent['gateId'])).toBe('rejected');

    // The child, once terminal, is restartable itself: not one restart per task.
    await reject(child);
    const grandchild = appliedDetail(
      await asPerson(s, restartBody(taskId, child['lineageId'])),
      'task.restart of the terminal child',
    );
    expect(grandchild['restartsLineageId']).toBe(child['lineageId']);
    expect(await lineage(grandchild['lineageId'])).toStrictEqual({
      state: 'live',
      restarts: child['lineageId'],
    });
    expect(await childrenOf(child['lineageId'])).toBe(1);
    expect(await childrenOf(parent['lineageId'])).toBe(1);
  });

  it('G05 ruling 4: a parentless proposal beside a rejected lineage is fresh, and clears nothing', async () => {
    const taskId = await createTask(s, 'rejected, then proposed afresh');
    const rejected = await propose(s, taskId, { purpose: freshPurpose() });
    await reject(rejected);
    const before = await runtimeState(taskId);

    const fresh = await propose(s, taskId, { purpose: freshPurpose() });
    expect(fresh['lineageId']).not.toBe(rejected['lineageId']);
    expect(await lineage(fresh['lineageId'])).toStrictEqual({ state: 'live', restarts: null });
    expect(await gateState(fresh['gateId'])).toBe('pending');
    // Nothing the rejected lineage had is reused or reopened.
    expect(await lineage(rejected['lineageId'])).toStrictEqual({
      state: 'rejected',
      restarts: null,
    });
    expect(await gateState(rejected['gateId'])).toBe('rejected');
    expect(await childrenOf(rejected['lineageId'])).toBe(0);
    expect(await runtimeState(taskId)).toStrictEqual(before);
    // The fresh proposal holds nothing until its own approval.
    expect(
      await count(
        `select count(*)::text as n from public.reservations
          where business_id = $1 and version_id = $2`,
        [fresh['versionId']],
      ),
    ).toBe(0);
  });

  it('G05 ruling 4: beside a cancelled lineage, its hold and lease stay terminal and unreused', async () => {
    const taskId = await createTask(s, 'worked, cancelled, then proposed afresh');
    const old = await propose(s, taskId, { purpose: freshPurpose() });
    const decision = await approve(s, old);
    const picked = await pickup(s, decision['reservationId']);
    appliedDetail(
      await asPerson(s, {
        command: 'task.cancel',
        operationId: randomUUID(),
        recordId: taskId,
        lineageId: old['lineageId'],
        reason: 'the client withdrew the request',
      }),
      'task.cancel',
    );
    const before = await runtimeState(taskId);

    const fresh = await propose(s, taskId, { purpose: freshPurpose() });
    expect(await lineage(fresh['lineageId'])).toStrictEqual({ state: 'live', restarts: null });
    expect(await gateState(fresh['gateId'])).toBe('pending');
    expect(await lineage(old['lineageId'])).toStrictEqual({ state: 'cancelled', restarts: null });
    expect(await runtimeState(taskId)).toStrictEqual(before);
    expect(
      await count(
        `select count(*)::text as n from public.leases
          where business_id = $1 and id = $2 and state = 'live'`,
        [picked['leaseId']],
      ),
    ).toBe(0);
    expect(
      await count(
        `select count(*)::text as n from public.reservations
          where business_id = $1 and id = $2 and state = 'abandoned'`,
        [decision['reservationId']],
      ),
    ).toBe(1);
    // The cancelled lineage's hold is not claimed again beside the fresh one.
    expect(
      codeOf(
        await asAgent(s, {
          command: 'task.pickup',
          operationId: randomUUID(),
          reservationId: decision['reservationId'],
          leaseSeconds: 600,
        }),
      ),
    ).toBe('RESERVATION_NOT_CLAIMABLE');
  });

  it('W05: no room in the envelope under a cap with room is BUDGET_UNAVAILABLE, and writes nothing', async () => {
    const taskId = await createTask(s, 'an envelope sized by its first approval');
    // Two lineages proposed before any envelope exists, each fitting the cap.
    // Approving the first opens the envelope at its 2,000 and fills it; the
    // second then asks 2,000 of an envelope with no room left. Proposing it
    // after the approval is refused at propose since SOL-R3-3.
    const v1 = await propose(s, taskId, { purpose: freshPurpose(), maximumMinor: 2_000 });
    const v2 = await propose(s, taskId, { purpose: freshPurpose(), maximumMinor: 2_000 });
    await approve(s, v1);
    // The cap has room for it many times over.
    const capRoom = await count(
      `select (c.limit_minor - coalesce(sum(e.held_minor + e.actual_minor), 0))::text as n
         from public.budget_caps c
         left join public.task_envelopes e on e.business_id = c.business_id and e.cap_id = c.id
        where c.business_id = $1 and c.id = $2 group by c.limit_minor`,
      [s.capId],
    );
    expect(capRoom).toBeGreaterThan(3_000 * 100);

    const before = await runtimeState(taskId);
    const body = approveBody(v2);
    const refused = await asPerson(s, body);
    expect(codeOf(refused)).toBe('BUDGET_UNAVAILABLE');
    expect(await runtimeState(taskId)).toStrictEqual(before);
    expect(await gateState(v2['gateId'])).toBe('pending');
    expect(
      await count(
        `select count(*)::text as n from public.reservations
          where business_id = $1 and version_id = $2`,
        [v2['versionId']],
      ),
    ).toBe(0);
    expect(await auditOf(body['operationId'])).toStrictEqual(['refused/BUDGET_UNAVAILABLE']);
  });
});
