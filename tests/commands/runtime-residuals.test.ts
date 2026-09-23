// SPDX-License-Identifier: AGPL-3.0-only
//
// RUNTIME-RESIDUALS items 4b and 5, through the mounted command entry.
//
// 4b. Root ruling 2 (ROOT-01a437a): an explicitly present null is
// FIELD_VALUE_INVALID; `leaseSeconds` is a positive safe integer within the
// owning range and `report` a non-null, non-array object. Before this suite
// the person route read a present `leaseSeconds: null` as the default on
// pickup and heartbeat, and spread a null, array or string `report` into an
// object on handback. The agent route already refused them; both principals
// are asserted here, each with no write and one refused audit row.
//
// 5. TRANSACTION-CONTRACT line 64 and minimum contract lines 139 and 337: the
// pickup brief names its excluded operations *with reasons*, for the person
// and the agent claimant alike.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { pathOf } from '../../packages/core-records/src/commands/surface.ts';
import { enrol, grantTo, type Member } from './fixture.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from '../api/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

type Name = Parameters<typeof pathOf>[0];
const detailOf = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] as Record<string, unknown> | undefined) ?? {};

/** The present, malformed renewals: none of them is the default. */
const BAD_SECONDS: readonly unknown[] = [null, '60', [60], 1.5, 0, -5];
const BAD_REPORTS: readonly unknown[] = [null, [], ['a'], 'x', 7];

describe.skipIf(serverUrl === undefined)('runtime residuals: operands and exclusions', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let approverToken: string;
  let agentToken: string;
  let worker: Member;
  let workerToken: string;

  beforeAll(async () => {
    fixture = await createApiFixture('rres');
    api = fixture.compose();
    approverToken = await tokenFor(fixture.member.presented.subject);
    agentToken = await tokenFor(fixture.agent.subject);
    worker = await enrol(fixture.db.app, fixture.business, 'worker');
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await grantTo(tx, worker, 'write');
      await grantTo(tx, worker, 'read');
    });
    workerToken = await tokenFor(worker.presented.subject);
  }, 120_000);

  afterAll(async () => {
    await fixture?.drop();
  });

  const asPerson = async (name: Name, body: Record<string, unknown>): Promise<Answer> =>
    await post(api, `/api/b/${BUSINESS_KEY}${pathOf(name)}`, body, authorised(workerToken));

  const asAgent = async (
    name: Name,
    body: Record<string, unknown>,
    credential?: string,
  ): Promise<Answer> =>
    await post(api, `/api/a/b/${BUSINESS_KEY}${pathOf(name)}`, body, {
      ...authorised(agentToken),
      ...(credential === undefined ? {} : { 'x-agent-delegation': credential }),
    });

  const scalar = async (text: string, values: readonly unknown[]): Promise<string | null> =>
    (await fixture.db.admin.execute<{ readonly v: string | null }>(text, [...values]))[0]?.v ??
    null;

  /** Refused audit rows for one command and actor, with the operand code. */
  const refusedAudits = async (command: Name, actorId: string): Promise<number> =>
    Number(
      await scalar(
        `select count(*)::text as v from public.audit_events
          where business_id = $1 and command = $2 and actor_id = $3
            and outcome = 'refused' and refusal_code = 'FIELD_VALUE_INVALID'`,
        [fixture.business, command, actorId],
      ),
    );

  const approver = async (name: Name, body: Record<string, unknown>): Promise<Answer> =>
    await post(api, `/api/b/${BUSINESS_KEY}${pathOf(name)}`, body, authorised(approverToken));

  /** A reservation on the queue, created, proposed and approved by the approver. */
  async function approved(purpose: string): Promise<string> {
    const created = await approver('task.create', {
      operationId: randomUUID(),
      fields: { title: `residual ${purpose}` },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const proposed = await approver('task.propose', {
      operationId: randomUUID(),
      recordId: created.body['recordId'],
      expectedRevision: created.body['revision'],
      purpose,
      maximumMinor: 1_000,
      currency: 'AUD',
      payload: { instruction: 'draft' },
      step: { kind: 'compose', payload: {} },
    });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
    const decided = await approver('task.decide', {
      operationId: randomUUID(),
      gateId: detailOf(proposed)['gateId'],
      versionId: detailOf(proposed)['versionId'],
      decision: 'approve',
      note: 'approved',
    });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    return String(detailOf(decided)['reservationId']);
  }

  const expiresOf = async (leaseId: string): Promise<string | null> =>
    await scalar(`select expires_at::text as v from public.leases where id = $1`, [leaseId]);

  it('refuses a present null leaseSeconds on person pickup, writing no lease', async () => {
    const reservationId = await approved('person_null_pickup');
    const before = await refusedAudits('task.pickup', worker.actorId);
    const answer = await asPerson('task.pickup', {
      operationId: randomUUID(),
      reservationId,
      leaseSeconds: null,
    });
    expect(answer.body['code'], JSON.stringify(answer.body)).toBe('FIELD_VALUE_INVALID');
    expect(answer.body['names']).toStrictEqual(['leaseSeconds']);
    expect(
      await scalar(`select count(*)::text as v from public.leases where reservation_id = $1`, [
        reservationId,
      ]),
    ).toBe('0');
    expect(await refusedAudits('task.pickup', worker.actorId)).toBe(before + 1);
  }, 60_000);

  it('refuses each malformed leaseSeconds on heartbeat, on both principals', async () => {
    const personPick = await asPerson('task.pickup', {
      operationId: randomUUID(),
      reservationId: await approved('person_bad_renewal'),
    });
    expect(personPick.status, JSON.stringify(personPick.body)).toBe(200);
    const agentPick = await asAgent('task.pickup', {
      operationId: randomUUID(),
      reservationId: await approved('agent_bad_renewal'),
    });
    expect(agentPick.status, JSON.stringify(agentPick.body)).toBe(200);
    const principals = [
      {
        label: 'person',
        actorId: worker.actorId,
        leaseId: String(detailOf(personPick)['leaseId']),
        send: async (body: Record<string, unknown>): Promise<Answer> =>
          await asPerson('task.heartbeat', body),
      },
      {
        label: 'agent',
        actorId: fixture.agentActorId,
        leaseId: String(detailOf(agentPick)['leaseId']),
        send: async (body: Record<string, unknown>): Promise<Answer> =>
          await asAgent('task.heartbeat', body, String(detailOf(agentPick)['credential'])),
      },
    ];
    for (const principal of principals) {
      for (const leaseSeconds of BAD_SECONDS) {
        const label = `${principal.label} leaseSeconds ${JSON.stringify(leaseSeconds)}`;
        /* eslint-disable no-await-in-loop -- one refusal at a time, each checked */
        const expires = await expiresOf(principal.leaseId);
        const before = await refusedAudits('task.heartbeat', principal.actorId);
        const answer = await principal.send({
          operationId: randomUUID(),
          leaseId: principal.leaseId,
          fence: 1,
          leaseSeconds,
        });
        expect(answer.body['code'], label).toBe('FIELD_VALUE_INVALID');
        expect(answer.body['names'], label).toStrictEqual(['leaseSeconds']);
        expect(await expiresOf(principal.leaseId), label).toBe(expires);
        expect(await refusedAudits('task.heartbeat', principal.actorId), label).toBe(before + 1);
        /* eslint-enable no-await-in-loop */
      }
    }
  }, 120_000);

  it('refuses a null, array or string report on person handback, settling nothing', async () => {
    const picked = await asPerson('task.pickup', {
      operationId: randomUUID(),
      reservationId: await approved('person_bad_report'),
    });
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);
    const leaseId = String(detailOf(picked)['leaseId']);
    for (const report of BAD_REPORTS) {
      const label = `report ${JSON.stringify(report)}`;
      /* eslint-disable no-await-in-loop -- one refusal at a time, each checked */
      const before = await refusedAudits('task.handback', worker.actorId);
      const answer = await asPerson('task.handback', {
        operationId: randomUUID(),
        leaseId,
        fence: 1,
        outcome: 'completed',
        report,
      });
      expect(answer.body['code'], label).toBe('FIELD_VALUE_INVALID');
      expect(answer.body['names'], label).toStrictEqual(['report']);
      expect(
        await scalar(
          `select count(*)::text as v from public.handback_reports where lease_id = $1`,
          [leaseId],
        ),
        label,
      ).toBe('0');
      expect(await scalar(`select state as v from public.leases where id = $1`, [leaseId])).toBe(
        'live',
      );
      expect(await refusedAudits('task.handback', worker.actorId), label).toBe(before + 1);
      /* eslint-enable no-await-in-loop */
    }
  }, 120_000);

  it('keeps the documented default when leaseSeconds is left out', async () => {
    const picked = await asPerson('task.pickup', {
      operationId: randomUUID(),
      reservationId: await approved('person_default_lease'),
    });
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);
    const leaseId = String(detailOf(picked)['leaseId']);
    const span = async (): Promise<number> =>
      Number(
        await scalar(
          `select extract(epoch from (expires_at - now()))::int::text as v
             from public.leases where id = $1`,
          [leaseId],
        ),
      );
    expect(Math.abs((await span()) - 15 * 60)).toBeLessThan(30);
    const renewed = await asPerson('task.heartbeat', {
      operationId: randomUUID(),
      leaseId,
      fence: 1,
    });
    expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);
    expect(Math.abs((await span()) - 15 * 60)).toBeLessThan(30);
  }, 60_000);

  it('names a reason for every excluded operation, person and agent', async () => {
    const person = await asPerson('task.pickup', {
      operationId: randomUUID(),
      reservationId: await approved('person_exclusions'),
    });
    const agent = await asAgent('task.pickup', {
      operationId: randomUUID(),
      reservationId: await approved('agent_exclusions'),
    });
    for (const [label, answer] of [
      ['person', person],
      ['agent', agent],
    ] as const) {
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      const excluded = detailOf(answer)['excludedOperations'] as readonly unknown[];
      expect(excluded.length, label).toBeGreaterThan(0);
      for (const entry of excluded) {
        expect(entry, label).toMatchObject({
          operation: expect.stringMatching(/\S/u),
          reason: expect.stringMatching(/\S/u),
        });
      }
      expect(
        excluded.map((entry) => (entry as { operation: string }).operation),
        label,
      ).toStrictEqual(['effect dispatch', 'actual expenditure', 'task.decide on this work']);
    }
  }, 60_000);
});
