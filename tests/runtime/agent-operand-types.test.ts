// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent's operands are read as the JSON they arrived as (Sol 6 AUTHORITY-2).
//
// API.md types each handback operand, and the person entry refuses an array
// outcome or a string fence by name. The agent entry used to run each operand
// through `String(...)` or `Number(...)` first, so `reservationId: [id]`
// claimed the reservation, `fence: "1"` and `outcome: ["completed"]` settled
// the lease, and after the person's write grant lapsed the same array outcome
// was kept as a report the restricted intake keeps only when otherwise valid
// (AUTHORITY.md). Each is now the typed refusal, before any authority is read,
// and moves nothing. A string id, a numeric fence and a string outcome are the
// positive controls, over the same agent prefix.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { ADMIN_ACTIONS, ADMIN_COLLECTIONS, enrolAgent, enrolCaller } from '../acceptance/cast.ts';
import { PROPOSAL } from '../acceptance/role-case-bodies.ts';
import type { Caller } from '../acceptance/world.ts';
import { createIdentWorld, type IdentWorld } from '../acceptance/ident-audit-cases.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { WHOLE_BUSINESS } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('agent operands, typed as sent', () => {
  let w: IdentWorld;

  beforeAll(async () => {
    w = await createIdentWorld('agent_operand_types');
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

  /** An approved reservation, its approver and a fresh agent; `shortWrite` as the intake suite issues it. */
  async function approved(name: string, shortWrite = false) {
    const { world } = w.h;
    const approver: Caller = await enrolCaller(world.db, world.alpha, 'alpha', name, {
      membership: true,
      actions: shortWrite ? ADMIN_ACTIONS.filter((action) => action !== 'write') : ADMIN_ACTIONS,
      collections: ADMIN_COLLECTIONS,
    });
    if (shortWrite) {
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
    const agent = await enrolAgent(world.db, world.alpha, world.ada.actorId as string);
    const made = await w.person(approver, 'task.create', { fields: { title: `typed ${name}` } });
    const proposed = await w.person(approver, 'task.propose', {
      recordId: made.body['recordId'],
      expectedRevision: made.body['revision'],
      ...PROPOSAL,
    });
    const gate = proposed.body['detail'] as Record<string, unknown>;
    const decided = await w.person(approver, 'task.decide', {
      gateId: gate['gateId'],
      versionId: gate['versionId'],
      decision: 'approve',
      note: 'approved for the operand proof',
    });
    const reservationId = String(
      (decided.body['detail'] as Record<string, unknown>)['reservationId'],
    );
    return { approver, agent, taskId: String(made.body['recordId']), reservationId };
  }

  async function picked(name: string, shortWrite = false) {
    const work = await approved(name, shortWrite);
    const answer = await w.agent(work.agent, 'task.pickup', {
      operationId: randomUUID(),
      reservationId: work.reservationId,
    });
    expect(answer.code, answer.text).toBe('ok');
    const detail = answer.body['detail'] as Record<string, unknown>;
    return {
      ...work,
      leaseId: String(detail['leaseId']),
      fence: Number(detail['fence']),
      credential: String(detail['credential']),
    };
  }

  const leasesOn = async (taskId: string): Promise<number> =>
    await count(`select count(*)::text as n from public.leases where task_id = $1`, [taskId]);
  const reportsOn = async (leaseId: string): Promise<readonly string[]> =>
    (
      await admin<{ disposition: string }>(
        `select disposition from public.handback_reports where lease_id = $1 order by created_at`,
        [leaseId],
      )
    ).map((row) => row.disposition);
  const leaseState = async (leaseId: string): Promise<string | undefined> =>
    (await admin<{ state: string }>(`select state from public.leases where id = $1`, [leaseId]))[0]
      ?.state;
  const refusedOnce = async (operationId: unknown, code: string): Promise<void> => {
    expect(
      await count(
        `select count(*)::text as n from public.audit_events
          where operation_id = $1 and outcome = 'refused' and refusal_code = $2`,
        [operationId, code],
      ),
    ).toBe(1);
  };

  it('refuses a reservation id sent as an array, claiming nothing; the string claims it', async () => {
    const work = await approved('array_reservation');
    const sent = { operationId: randomUUID(), reservationId: [work.reservationId] };
    const answer = await w.agent(work.agent, 'task.pickup', sent);
    expect({ status: answer.status, code: answer.code }, answer.text).toStrictEqual({
      status: 400,
      code: 'COMMAND_BODY_INVALID',
    });
    expect(answer.body['names']).toStrictEqual(['reservationId']);
    expect(await leasesOn(work.taskId)).toBe(0);
    await refusedOnce(sent.operationId, 'COMMAND_BODY_INVALID');

    const control = await w.agent(work.agent, 'task.pickup', {
      operationId: randomUUID(),
      reservationId: work.reservationId,
    });
    expect(control.code, control.text).toBe('ok');
    expect(await leasesOn(work.taskId)).toBe(1);
  });

  it('refuses a string fence and an array outcome on a live lease, settling nothing', async () => {
    const x = await picked('live_typed_handback');
    const base = { leaseId: x.leaseId, fence: x.fence, outcome: 'completed', report: {} };
    for (const [field, value] of [
      ['fence', String(x.fence)],
      ['outcome', ['completed']],
    ] as const) {
      const sent = { ...base, operationId: randomUUID(), [field]: value };
      // eslint-disable-next-line no-await-in-loop -- one lease, one call at a time
      const answer = await w.agent(x.agent, 'task.handback', sent, x.credential);
      expect({ status: answer.status, code: answer.code }, answer.text).toStrictEqual({
        status: 422,
        code: 'FIELD_VALUE_INVALID',
      });
      expect(answer.body['names']).toStrictEqual([field]);
      // eslint-disable-next-line no-await-in-loop
      expect(await leaseState(x.leaseId)).toBe('live');
      // eslint-disable-next-line no-await-in-loop
      expect(await reportsOn(x.leaseId)).toStrictEqual([]);
      // eslint-disable-next-line no-await-in-loop
      await refusedOnce(sent.operationId, 'FIELD_VALUE_INVALID');
    }

    const control = await w.agent(
      x.agent,
      'task.handback',
      { ...base, operationId: randomUUID() },
      x.credential,
    );
    expect(control.code, control.text).toBe('ok');
    expect(await reportsOn(x.leaseId)).toStrictEqual(['settled']);
  });

  it('retains no report for an array outcome after the write grant lapsed; a string one is kept', async () => {
    const x = await picked('lapsed_typed_handback', true);
    const lapsed = await admin<{ id: string }>(
      `update public.grants set expires_at = now() - interval '1 second'
        where business_id = $1 and subject_kind = 'person' and subject_id = $2
          and collection = 'task' and action = 'write' and expires_at is not null
          and revoked_at is null
        returning id`,
      [w.h.world.alpha, x.approver.personId],
    );
    expect(lapsed).toHaveLength(1);

    const sent = {
      operationId: randomUUID(),
      leaseId: x.leaseId,
      fence: x.fence,
      outcome: ['completed'],
      report: { wrote: 'finished after the write lapsed' },
    };
    const answer = await w.agent(x.agent, 'task.handback', sent, x.credential);
    expect({ status: answer.status, code: answer.code }, answer.text).toStrictEqual({
      status: 422,
      code: 'FIELD_VALUE_INVALID',
    });
    expect(await reportsOn(x.leaseId)).toStrictEqual([]);
    await refusedOnce(sent.operationId, 'FIELD_VALUE_INVALID');

    const control = await w.agent(
      x.agent,
      'task.handback',
      { ...sent, operationId: randomUUID(), outcome: 'completed' },
      x.credential,
    );
    expect(control.code, control.text).toBe('DELEGATION_NARROWED');
    expect(await reportsOn(x.leaseId)).toStrictEqual(['retained']);
  });
});
