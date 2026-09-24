// SPDX-License-Identifier: AGPL-3.0-only
//
// L6 W02 (a) and root ruling 6: what a pickup hands its actual claimant, field
// by field, against the rows the pickup wrote, for an agent and for a person.
//
// TRANSACTION-CONTRACT line 64 asks for the brief, context with declared
// incompleteness and handles, permitted/excluded operations and reasons,
// expected versions, envelope/reservation and lease, and the handback shape.
// I12 asks that the work be person-authorised and bounded, with a real lease,
// delegation and payload. The brief stays `{taskId, purpose}` (ruling 6).
//
// `handbackShape` is derived from the owning `task.handback` contract. The
// assertions below check it against that contract's behaviour rather than
// against itself: the operands it calls required are the ones whose absence
// the handback refuses, it advertises no `expectedVersions` operand, it names
// where the credential travels and never the credential, and the version
// binding it describes is the one the handback enforces.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DELEGATION_HEADER } from '../../packages/core-records/src/commands/surface.ts';
import { DECLARED_INCOMPLETENESS } from '../../packages/core-runtime/src/pickup.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { createControls, detailOf, PROPOSAL, type Controls } from '../api/controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const COMMON_KEYS = [
  'attemptId',
  'authorisedByPersonId',
  'brief',
  'budgetEnvelope',
  'claimant',
  'declaredIncompleteness',
  'excludedOperations',
  'expectedVersions',
  'expiresAt',
  'fence',
  'handbackShape',
  'holderActorId',
  'leaseId',
  'permittedOperations',
  'reservationId',
  'runId',
  'taskId',
  'versionId',
];
const AGENT_KEYS = [...COMMON_KEYS, 'credential', 'delegationId', 'purposeScope'].toSorted();

/** The descriptor, and that it matches what `task.handback` actually does. */
function expectShape(
  detail: Record<string, unknown>,
  claimant: 'agent' | 'person',
): Record<string, unknown> {
  const shape = detail['handbackShape'] as Record<string, unknown>;
  expect(shape).toBeTypeOf('object');
  expect(shape['operation']).toBe('task.handback');
  expect(shape['required']).toStrictEqual(['leaseId', 'fence', 'outcome']);
  expect(shape['optional']).toStrictEqual(['report', 'actualMinor', 'successor']);
  expect(Object.keys(shape['operands'] as object).toSorted()).toStrictEqual(
    ['actualMinor', 'fence', 'leaseId', 'outcome', 'report', 'successor'].toSorted(),
  );
  expect(shape['operationIdentity']).toMatchObject({
    operand: 'operationId',
    presence: 'required',
  });
  expect(shape['outcomes']).toStrictEqual(['completed', 'failed']);
  expect(shape['lease']).toMatchObject({ leaseId: detail['leaseId'], fence: detail['fence'] });
  expect(shape['versionBinding']).toMatchObject({
    operand: null,
    versionId: detail['versionId'],
  });
  // Nothing the handback does not consume is advertised as an operand.
  const text = JSON.stringify(shape);
  expect(Object.keys(shape['operands'] as object)).not.toContain('expectedVersions');
  expect(Object.keys(shape['operands'] as object)).not.toContain('expectedRevision');
  expect(shape['credential']).toMatchObject(
    claimant === 'agent'
      ? { transport: 'header', header: DELEGATION_HEADER }
      : { transport: 'bearer' },
  );
  if (claimant === 'agent') {
    expect(text).not.toContain(String(detail['credential']));
    expect(text).not.toContain(String(detail['delegationId']));
  }
  return shape;
}

describe.skipIf(serverUrl === undefined)('W02 (a): the pickup payload, field by field', () => {
  let c: Controls;

  beforeAll(async () => {
    c = await createControls('pickup_payload');
  }, 120_000);
  afterAll(async () => {
    await c?.drop();
  });

  async function approvedWork(purpose: string): Promise<{
    readonly taskId: string;
    readonly reservationId: string;
    readonly versionId: string;
  }> {
    const task = await c.createTask(`payload ${purpose}`);
    const proposal = await c.propose(task.id, task.revision, purpose);
    const reservationId = await c.approve(proposal);
    return { taskId: task.id, reservationId, versionId: String(proposal['versionId']) };
  }

  /** The rows the pickup wrote, read on the administrative connection. */
  async function rowsFor(leaseId: string): Promise<Record<string, unknown>> {
    const rows = await c.fixture.db.admin.execute<Record<string, unknown>>(
      `select l.fence::text as fence, l.reservation_id, l.run_id, l.task_id, l.holder_actor_id,
              l.authorised_by_person_id, l.delegation_id, l.expires_at, res.version_id,
              res.envelope_id, res.state as hold, res.held_minor::text as held,
              (select att.id from public.attempts att
                where att.business_id = res.business_id and att.reservation_id = res.id) as attempt_id,
              t.revision::text as revision, env.currency,
              d.agent_actor_id, d.purpose_scope_id
         from public.leases l
         join public.reservations res on res.business_id = l.business_id and res.id = l.reservation_id
         join public.records t on t.business_id = l.business_id and t.id = l.task_id
         join public.task_envelopes env on env.business_id = res.business_id and env.id = res.envelope_id
         left join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
        where l.id = $1`,
      [leaseId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`no lease ${leaseId}`);
    return row;
  }

  it('an agent pickup: every handle is the row it names, the brief is {taskId, purpose}', async () => {
    const work = await approvedWork(`agent_${randomUUID().slice(0, 8)}`);
    const answer = await c.asAgent('task.pickup', {
      operationId: randomUUID(),
      reservationId: work.reservationId,
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const detail = detailOf(answer);
    expect(Object.keys(detail).toSorted()).toStrictEqual(AGENT_KEYS);

    const row = await rowsFor(String(detail['leaseId']));
    expect(detail['claimant']).toBe('agent');
    expect(detail['fence']).toBe(Number(row['fence']));
    expect(detail['reservationId']).toBe(work.reservationId);
    expect(row['reservation_id']).toBe(work.reservationId);
    expect(row['hold']).toBe('held');
    expect(detail['attemptId']).toBe(row['attempt_id']);
    expect(detail['taskId']).toBe(work.taskId);
    expect(detail['runId']).toBe(row['run_id']);
    expect(detail['versionId']).toBe(work.versionId);
    expect(row['version_id']).toBe(work.versionId);
    expect(new Date(String(detail['expiresAt'])).getTime()).toBe(
      new Date(row['expires_at'] as string).getTime(),
    );
    expect(detail['declaredIncompleteness']).toStrictEqual(DECLARED_INCOMPLETENESS);
    // I12: person-authorised, held by the agent, under a real delegation.
    expect(detail['holderActorId']).toBe(c.fixture.agentActorId);
    expect(row['holder_actor_id']).toBe(c.fixture.agentActorId);
    expect(row['agent_actor_id']).toBe(c.fixture.agentActorId);
    expect(detail['authorisedByPersonId']).toBe(c.manager.personId);
    expect(row['authorised_by_person_id']).toBe(c.manager.personId);
    expect(detail['delegationId']).toBe(row['delegation_id']);
    expect(detail['credential']).toBeTypeOf('string');
    expect(String(detail['credential']).length).toBeGreaterThan(20);
    expect(detail['purposeScope']).toStrictEqual({ kind: 'record', id: work.taskId });
    expect(row['purpose_scope_id']).toBe(work.taskId);

    expect(detail['brief']).toStrictEqual({ taskId: work.taskId, purpose: expect.any(String) });
    expect(detail['expectedVersions']).toStrictEqual({
      versionId: work.versionId,
      taskRevision: Number(row['revision']),
    });
    expect(detail['budgetEnvelope']).toStrictEqual({
      envelopeId: row['envelope_id'],
      currency: row['currency'],
      heldMinor: Number(row['held']),
    });
    expect(detail['permittedOperations']).toStrictEqual([
      'task.read',
      'task.comment',
      'task.heartbeat',
      'task.handback',
    ]);
    const excluded = detail['excludedOperations'] as { operation: string; reason: string }[];
    expect(excluded.map((entry) => entry.operation)).toStrictEqual([
      'effect dispatch',
      'actual expenditure',
      'task.decide on this work',
    ]);
    expect(excluded.every((entry) => entry.reason.length > 0)).toBe(true);

    expectShape(detail, 'agent');

    // The descriptor's required operands are the ones the handback refuses
    // without, and following it settles the work.
    const credential = String(detail['credential']);
    const missing = await c.asAgent(
      'task.handback',
      { operationId: randomUUID(), leaseId: detail['leaseId'], fence: detail['fence'] },
      credential,
    );
    expect(missing.status, JSON.stringify(missing.body)).toBe(422);
    const settled = await c.asAgent(
      'task.handback',
      {
        operationId: randomUUID(),
        leaseId: detail['leaseId'],
        fence: detail['fence'],
        outcome: 'completed',
      },
      credential,
    );
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
  });

  it('a person pickup: the same handles and descriptor, and no delegation half at all', async () => {
    const work = await approvedWork(`person_${randomUUID().slice(0, 8)}`);
    const answer = await c.asPerson('task.pickup', {
      operationId: randomUUID(),
      reservationId: work.reservationId,
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const detail = detailOf(answer);
    expect(Object.keys(detail).toSorted()).toStrictEqual(COMMON_KEYS.toSorted());

    const row = await rowsFor(String(detail['leaseId']));
    expect(detail['claimant']).toBe('person');
    expect(detail['fence']).toBe(Number(row['fence']));
    expect(detail['reservationId']).toBe(work.reservationId);
    expect(detail['attemptId']).toBe(row['attempt_id']);
    expect(detail['runId']).toBe(row['run_id']);
    expect(detail['versionId']).toBe(work.versionId);
    expect(detail['holderActorId']).toBe(c.manager.actorId);
    expect(row['holder_actor_id']).toBe(c.manager.actorId);
    expect(row['delegation_id']).toBeNull();
    expect(detail['authorisedByPersonId']).toBe(c.manager.personId);
    expect(detail['declaredIncompleteness']).toStrictEqual(DECLARED_INCOMPLETENESS);
    expect(detail['brief']).toStrictEqual({ taskId: work.taskId, purpose: expect.any(String) });
    expect(detail['expectedVersions']).toStrictEqual({
      versionId: work.versionId,
      taskRevision: Number(row['revision']),
    });
    expect(detail['budgetEnvelope']).toStrictEqual({
      envelopeId: row['envelope_id'],
      currency: row['currency'],
      heldMinor: Number(row['held']),
    });
    const excluded = detail['excludedOperations'] as { operation: string; reason: string }[];
    expect(excluded.map((entry) => entry.operation)).toStrictEqual([
      'effect dispatch',
      'actual expenditure',
      'task.decide on this work',
    ]);

    const shape = expectShape(detail, 'person');
    expect(JSON.stringify(shape)).not.toContain(DELEGATION_HEADER);
  });

  it('the version binding it describes is enforced: a superseded version cannot settle', async () => {
    const task = await c.createTask('payload superseded');
    const proposal = await c.propose(task.id, task.revision, `sup_${randomUUID().slice(0, 8)}`);
    const picked = await c.pickup(await c.approve(proposal));
    expect((picked['handbackShape'] as Record<string, unknown>)['versionBinding']).toMatchObject({
      versionId: proposal['versionId'],
    });
    const revision = await c.fixture.db.admin.execute<{ readonly revision: string }>(
      `select revision::text as revision from public.records where id = $1`,
      [task.id],
    );
    const superseding = await c.asPerson('task.propose', {
      recordId: task.id,
      expectedRevision: Number(revision[0]?.revision),
      ...PROPOSAL,
      purpose: `v2_${randomUUID().slice(0, 8)}`,
      lineageId: proposal['lineageId'],
    });
    expect(superseding.status, JSON.stringify(superseding.body)).toBe(200);
    const handback = await c.asAgent(
      'task.handback',
      {
        operationId: randomUUID(),
        leaseId: picked['leaseId'],
        fence: picked['fence'],
        outcome: 'completed',
      },
      String(picked['credential']),
    );
    // Supersession retires the lease and revokes the delegation, so the agent
    // is refused before the version is read; either way the work is not settled.
    expect(handback.status).not.toBe(200);
    expect(
      await c.count(
        `select count(*)::text as n from public.handback_reports
          where lease_id = $1 and disposition = 'settled'`,
        [picked['leaseId']],
      ),
    ).toBe(0);
  });
});
