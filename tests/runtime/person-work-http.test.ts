// SPDX-License-Identifier: AGPL-3.0-only
//
// EX-01 over the real person route: a person picks work up as themselves,
// renews it and hands it back, on a lease that carries no delegation.
//
// Transaction contract T3 line 66: "Person pickup uses the same work/lease
// contract without pretending the person is an agent." Ledger line 30 names
// the person as a pickup principal, and minimum contract line 331 says the
// same. Every call below goes through the mounted Hono app on the person
// prefix (`/api/b/...`) or the agent's own (`/api/a/b/...`), with a signed
// session, the way the browser and the CLI reach it.
//
// The approving person and the claimant are different people on purpose: the
// lease records who authorised the work and who holds it as two facts, and a
// test in which they were one person could not tell them apart.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { pathOf } from '../../packages/core-records/src/commands/surface.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
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

const personPath = (name: Parameters<typeof pathOf>[0]): string =>
  `/api/b/${BUSINESS_KEY}${pathOf(name)}`;
const agentPath = (name: Parameters<typeof pathOf>[0]): string =>
  `/api/a/b/${BUSINESS_KEY}${pathOf(name)}`;

const detailOf = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] as Record<string, unknown> | undefined) ?? {};

describe.skipIf(serverUrl === undefined)('person work on the person route (EX-01)', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let approverToken: string;
  let agentToken: string;
  let worker: Member;
  let workerToken: string;
  let other: Member;
  let otherToken: string;

  beforeAll(async () => {
    fixture = await createApiFixture('pw');
    api = fixture.compose();
    approverToken = await tokenFor(fixture.member.presented.subject);
    agentToken = await tokenFor(fixture.agent.subject);
    worker = await enrol(fixture.db.app, fixture.business, 'worker');
    other = await enrol(fixture.db.app, fixture.business, 'other');
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await grantTo(tx, worker, 'write');
      await grantTo(tx, worker, 'read');
      await grantTo(tx, other, 'write');
      await grantTo(tx, other, 'read');
    });
    workerToken = await tokenFor(worker.presented.subject);
    otherToken = await tokenFor(other.presented.subject);
  }, 120_000);

  afterAll(async () => {
    await fixture?.drop();
  });

  async function asPerson(
    name: Parameters<typeof pathOf>[0],
    body: Readonly<Record<string, unknown>>,
    token: string,
  ): Promise<Answer> {
    return await post(api, personPath(name), body, authorised(token));
  }

  async function asAgent(
    name: Parameters<typeof pathOf>[0],
    body: Readonly<Record<string, unknown>>,
    credential?: string,
  ): Promise<Answer> {
    return await post(api, agentPath(name), body, {
      ...authorised(agentToken),
      ...(credential === undefined ? {} : { 'x-agent-delegation': credential }),
    });
  }

  async function scalar(text: string, values: readonly unknown[]): Promise<string | null> {
    const rows = await fixture.db.admin.execute<{ readonly v: string | null }>(text, [...values]);
    return rows[0]?.v ?? null;
  }

  /** Created, proposed and approved by the approver: a reservation on the queue. */
  async function approved(purpose: string): Promise<{ taskId: string; reservationId: string }> {
    const created = await asPerson(
      'task.create',
      { operationId: randomUUID(), fields: { title: `person work ${purpose}` } },
      approverToken,
    );
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const proposed = await asPerson(
      'task.propose',
      {
        operationId: randomUUID(),
        recordId: created.body['recordId'],
        expectedRevision: created.body['revision'],
        purpose,
        maximumMinor: 2_500,
        currency: 'AUD',
        payload: { instruction: 'draft a reply to the client' },
        step: { kind: 'compose', payload: { tone: 'plain' } },
      },
      approverToken,
    );
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
    const decided = await asPerson(
      'task.decide',
      {
        operationId: randomUUID(),
        gateId: detailOf(proposed)['gateId'],
        versionId: detailOf(proposed)['versionId'],
        decision: 'approve',
        note: 'approved for a person to work',
      },
      approverToken,
    );
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    return {
      taskId: String(created.body['recordId']),
      reservationId: String(detailOf(decided)['reservationId']),
    };
  }

  it('claims, renews and hands back as the person, with the full payload and no delegation', async () => {
    const work = await approved('person_claims_own_work');
    const operationId = randomUUID();
    const body = { operationId, reservationId: work.reservationId, leaseSeconds: 600 };
    const picked = await asPerson('task.pickup', body, workerToken);
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);
    const detail = detailOf(picked);

    // T1-R8, for the actual principal.
    expect(detail['claimant']).toBe('person');
    expect(detail['holderActorId']).toBe(worker.actorId);
    expect(detail['authorisedByPersonId']).toBe(fixture.member.personId);
    expect(detail['taskId']).toBe(work.taskId);
    expect(detail['fence']).toBe(1);
    expect(detail['brief']).toStrictEqual({
      taskId: work.taskId,
      purpose: 'person_claims_own_work',
    });
    expect(detail['expectedVersions']).toMatchObject({ versionId: detail['versionId'] });
    expect(detail['budgetEnvelope']).toMatchObject({ currency: 'AUD', heldMinor: 2_500 });
    expect(detail['declaredIncompleteness']).toHaveLength(3);
    expect(detail['permittedOperations']).toContain('task.handback');
    expect(detail['excludedOperations']).toContainEqual(
      expect.objectContaining({ operation: 'effect dispatch' }),
    );
    // No agent half, and no placeholder for one.
    expect(Object.keys(detail)).not.toContain('credential');
    expect(Object.keys(detail)).not.toContain('delegationId');
    expect(Object.keys(detail)).not.toContain('purposeScope');

    // The lease is the person's: their actor, no delegation, the approver kept apart.
    const leaseId = String(detail['leaseId']);
    expect(
      await scalar(
        `select holder_actor_id::text || '/' || coalesce(delegation_id::text, 'none') || '/' ||
                authorised_by_person_id::text as v from public.leases where id = $1`,
        [leaseId],
      ),
    ).toBe(`${worker.actorId}/none/${fixture.member.personId}`);
    expect(
      await scalar(`select count(*)::text as v from public.delegations where agent_actor_id = $1`, [
        worker.actorId,
      ]),
    ).toBe('0');

    // Same-operation replay under current rights: the same identities, no second lease.
    const replayed = await asPerson('task.pickup', body, workerToken);
    expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
    expect(detailOf(replayed)['leaseId']).toBe(leaseId);
    expect(detailOf(replayed)['holderActorId']).toBe(worker.actorId);
    expect(
      await scalar(`select count(*)::text as v from public.leases where task_id = $1`, [
        work.taskId,
      ]),
    ).toBe('1');

    // A competing claimant cannot steal it, and is not told whose it is.
    const stolen = await asPerson(
      'task.pickup',
      { operationId: randomUUID(), reservationId: work.reservationId },
      otherToken,
    );
    expect(stolen.body['code']).toBe('RESERVATION_NOT_CLAIMABLE');
    expect(JSON.stringify(stolen.body)).not.toContain(leaseId);
    const fabricated = await asPerson(
      'task.pickup',
      { operationId: randomUUID(), reservationId: randomUUID() },
      otherToken,
    );
    expect(stolen.body['fixes']).toStrictEqual(fabricated.body['fixes']);
    const byAgent = await asAgent('task.pickup', {
      operationId: randomUUID(),
      reservationId: work.reservationId,
    });
    expect(byAgent.body['code']).toBe('RESERVATION_NOT_CLAIMABLE');

    // Renewal by its owner; nobody else renews it.
    const renewed = await asPerson(
      'task.heartbeat',
      { operationId: randomUUID(), leaseId, fence: 1, leaseSeconds: 1_200 },
      workerToken,
    );
    expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);
    expect(Date.parse(String(detailOf(renewed)['expiresAt']))).toBeGreaterThan(
      Date.parse(String(detail['expiresAt'])),
    );
    const renewedByOther = await asPerson(
      'task.heartbeat',
      { operationId: randomUUID(), leaseId, fence: 1 },
      otherToken,
    );
    expect(renewedByOther.body['code']).toBe('LEASE_NOT_OWNED');

    // Another person's handback writes nothing: no report, the lease still live.
    const byOther = await asPerson(
      'task.handback',
      { operationId: randomUUID(), leaseId, fence: 1, outcome: 'completed' },
      otherToken,
    );
    expect(byOther.body['code']).toBe('LEASE_NOT_OWNED');
    expect(
      await scalar(`select count(*)::text as v from public.handback_reports where lease_id = $1`, [
        leaseId,
      ]),
    ).toBe('0');

    // A stale fence from the owner is refused and settles nothing.
    const stale = await asPerson(
      'task.handback',
      { operationId: randomUUID(), leaseId, fence: 7, outcome: 'completed' },
      workerToken,
    );
    expect(stale.body['code']).toBe('LEASE_NOT_OWNED');
    expect(await scalar(`select state as v from public.leases where id = $1`, [leaseId])).toBe(
      'live',
    );

    // The owner hands back in one call.
    const handedBack = await asPerson(
      'task.handback',
      {
        operationId: randomUUID(),
        leaseId,
        fence: 1,
        outcome: 'completed',
        report: { summary: 'drafted by the person' },
      },
      workerToken,
    );
    expect(handedBack.status, JSON.stringify(handedBack.body)).toBe(200);
    expect(detailOf(handedBack)['reservationState']).toBe('abandoned');
    expect(await scalar(`select state as v from public.leases where id = $1`, [leaseId])).not.toBe(
      'live',
    );
  });

  it('refuses a person on an agent-owned lease, and an agent on a person-owned one', async () => {
    const agentWork = await approved('agent_owns_this_one');
    const agentPicked = await asAgent('task.pickup', {
      operationId: randomUUID(),
      reservationId: agentWork.reservationId,
    });
    expect(agentPicked.status, JSON.stringify(agentPicked.body)).toBe(200);
    const agentLease = detailOf(agentPicked);

    for (const name of ['task.heartbeat', 'task.handback'] as const) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await asPerson(
        name,
        {
          operationId: randomUUID(),
          leaseId: agentLease['leaseId'],
          fence: agentLease['fence'],
          ...(name === 'task.handback' ? { outcome: 'completed' } : {}),
        },
        approverToken,
      );
      expect(answer.body['code'], name).toBe('LEASE_NOT_OWNED');
    }
    expect(
      await scalar(
        `select state || '/' || (select count(*) from public.handback_reports r
                                  where r.lease_id = l.id)::text as v
           from public.leases l where id = $1`,
        [agentLease['leaseId']],
      ),
    ).toBe('live/0');

    const personWork = await approved('person_owns_this_one');
    const personPicked = await asPerson(
      'task.pickup',
      { operationId: randomUUID(), reservationId: personWork.reservationId },
      workerToken,
    );
    expect(personPicked.status, JSON.stringify(personPicked.body)).toBe(200);
    const personLease = detailOf(personPicked);
    for (const name of ['task.heartbeat', 'task.handback'] as const) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await asAgent(
        name,
        {
          operationId: randomUUID(),
          leaseId: personLease['leaseId'],
          fence: personLease['fence'],
          ...(name === 'task.handback' ? { outcome: 'completed' } : {}),
        },
        String(agentLease['credential']),
      );
      expect(answer.body['refused'], name).toBe(true);
    }
    expect(
      await scalar(
        `select state || '/' || (select count(*) from public.handback_reports r
                                  where r.lease_id = l.id)::text as v
           from public.leases l where id = $1`,
        [personLease['leaseId']],
      ),
    ).toBe('live/0');

    // The agent's own lease is still its own to hand back.
    const settled = await asAgent(
      'task.handback',
      {
        operationId: randomUUID(),
        leaseId: agentLease['leaseId'],
        fence: agentLease['fence'],
        outcome: 'completed',
      },
      String(agentLease['credential']),
    );
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
  });

  it('refuses renewal and handback once the person has lost write, with no effect', async () => {
    const loser = await enrol(fixture.db.app, fixture.business, 'loser');
    let loserWrite = '';
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      loserWrite = await grantTo(tx, loser, 'write');
      await grantTo(tx, loser, 'read');
    });
    const loserToken = await tokenFor(loser.presented.subject);
    const work = await approved('person_loses_rights');
    const picked = await asPerson(
      'task.pickup',
      { operationId: randomUUID(), reservationId: work.reservationId },
      loserToken,
    );
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);
    const lease = detailOf(picked);
    const before = await scalar(`select expires_at::text as v from public.leases where id = $1`, [
      lease['leaseId'],
    ]);

    await fixture.db.admin.execute(`update public.grants set revoked_at = now() where id = $1`, [
      loserWrite,
    ]);
    {
      const renewed = await asPerson(
        'task.heartbeat',
        { operationId: randomUUID(), leaseId: lease['leaseId'], fence: lease['fence'] },
        loserToken,
      );
      expect(renewed.body['refused']).toBe(true);
      const handedBack = await asPerson(
        'task.handback',
        {
          operationId: randomUUID(),
          leaseId: lease['leaseId'],
          fence: lease['fence'],
          outcome: 'completed',
        },
        loserToken,
      );
      expect(handedBack.body['refused']).toBe(true);
      expect(
        await scalar(
          `select expires_at::text || '/' || state || '/' ||
                  (select count(*) from public.handback_reports r where r.lease_id = l.id)::text as v
             from public.leases l where id = $1`,
          [lease['leaseId']],
        ),
      ).toBe(`${String(before)}/live/0`);
    }
  });
});
