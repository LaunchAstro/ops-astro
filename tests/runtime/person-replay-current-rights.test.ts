// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's replay answers to the rights held now (Sol 6 AUTHORITY-1).
//
// AUTHORITY.md: a revocation bites on the next call. A replay is a call, and
// a stored pickup receipt carries the brief, the purpose and the budget
// envelope, so the replay of a pickup after its covering `write` grant was
// revoked answers today's refusal rather than yesterday's receipt. The agent
// replay already asked this (`agent-replay.ts`); the person replay did not.
//
// Nothing is repeated either way: no second lease, and the register row the
// first call wrote is the row that is there afterwards.

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

const detailOf = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] as Record<string, unknown> | undefined) ?? {};

describe.skipIf(serverUrl === undefined)('a person replay under current rights', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let approverToken: string;
  let manager: Member;
  let managerToken: string;

  beforeAll(async () => {
    fixture = await createApiFixture('prr');
    api = fixture.compose();
    approverToken = await tokenFor(fixture.member.presented.subject);
    manager = await enrol(fixture.db.app, fixture.business, 'manager');
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await grantTo(tx, manager, 'manage');
      await grantTo(tx, manager, 'write');
    });
    managerToken = await tokenFor(manager.presented.subject);
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

  async function scalar(text: string, values: readonly unknown[]): Promise<string | null> {
    const rows = await fixture.db.admin.execute<{ readonly v: string | null }>(text, [...values]);
    return rows[0]?.v ?? null;
  }

  /** A worker holding `read` and one `write` grant, whose id is returned. */
  async function worker(name: string): Promise<{ member: Member; token: string; write: string }> {
    const member = await enrol(fixture.db.app, fixture.business, name);
    let write = '';
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      write = await grantTo(tx, member, 'write');
      await grantTo(tx, member, 'read');
    });
    return { member, token: await tokenFor(member.presented.subject), write };
  }

  /** Created, proposed and approved by the approver: a reservation on the queue. */
  async function approved(purpose: string): Promise<{ taskId: string; reservationId: string }> {
    const created = await asPerson(
      'task.create',
      { operationId: randomUUID(), fields: { title: `replay ${purpose}` } },
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

  async function registerRow(actorId: string, operationId: string): Promise<string | null> {
    return await scalar(
      `select command || '|' || payload_digest || '|' || outcome || '|' || result::text as v
         from public.operations where business_id = $1 and actor_id = $2 and operation_id = $3`,
      [fixture.business, actorId, operationId],
    );
  }

  async function lastEvent(operationId: string): Promise<string | null> {
    return await scalar(
      `select outcome || '/' || coalesce(refusal_code, '-') as v from public.audit_events
        where business_id = $1 and operation_id = $2 order by seq desc limit 1`,
      [fixture.business, operationId],
    );
  }

  it('refuses a pickup replay once the only covering write grant is revoked', async () => {
    const work = await approved('replay_after_revocation');
    const who = await worker('revoked-worker');
    const operationId = randomUUID();
    const body = { operationId, reservationId: work.reservationId, leaseSeconds: 600 };
    const picked = await asPerson('task.pickup', body, who.token);
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);
    const leaseId = String(detailOf(picked)['leaseId']);
    const stored = await registerRow(who.member.actorId, operationId);
    expect(stored).not.toBeNull();

    const revoked = await asPerson(
      'grant.revoke',
      { operationId: randomUUID(), grantId: who.write },
      managerToken,
    );
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

    const replayed = await asPerson('task.pickup', body, who.token);
    expect(replayed.status, JSON.stringify(replayed.body)).toBe(403);
    expect(replayed.body['code']).toBe('SCOPE_NOT_GRANTED');
    const shown = JSON.stringify(replayed.body);
    for (const kept of [leaseId, work.taskId, 'replay_after_revocation', 'budgetEnvelope']) {
      expect(shown).not.toContain(kept);
    }
    expect(
      await scalar(`select count(*)::text as v from public.leases where task_id = $1`, [
        work.taskId,
      ]),
    ).toBe('1');
    expect(await registerRow(who.member.actorId, operationId)).toBe(stored);
    expect(await lastEvent(operationId)).toBe('refused/SCOPE_NOT_GRANTED');
  });

  it('refuses a pickup replay whose lease is no longer live, under rights still held', async () => {
    const work = await approved('replay_after_handback');
    const who = await worker('handed-back-worker');
    const operationId = randomUUID();
    const body = { operationId, reservationId: work.reservationId, leaseSeconds: 600 };
    const picked = await asPerson('task.pickup', body, who.token);
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);
    const leaseId = String(detailOf(picked)['leaseId']);

    // Live rights, live lease: the receipt is released as stored.
    const live = await asPerson('task.pickup', body, who.token);
    expect(live.status, JSON.stringify(live.body)).toBe(200);
    expect(live.body).toStrictEqual(picked.body);

    const handedBack = await asPerson(
      'task.handback',
      { operationId: randomUUID(), leaseId, fence: 1, outcome: 'completed' },
      who.token,
    );
    expect(handedBack.status, JSON.stringify(handedBack.body)).toBe(200);
    const stored = await registerRow(who.member.actorId, operationId);

    const replayed = await asPerson('task.pickup', body, who.token);
    expect(replayed.status, JSON.stringify(replayed.body)).not.toBe(200);
    expect(replayed.body['code']).toBe('LEASE_EXPIRED');
    expect(JSON.stringify(replayed.body)).not.toContain(leaseId);
    expect(
      await scalar(`select count(*)::text as v from public.leases where task_id = $1`, [
        work.taskId,
      ]),
    ).toBe('1');
    expect(await registerRow(who.member.actorId, operationId)).toBe(stored);
    expect(await lastEvent(operationId)).toBe('refused/LEASE_EXPIRED');
  });

  it('refuses any stored success once its authority is gone, and replays it while held', async () => {
    const who = await worker('create-worker');
    const operationId = randomUUID();
    const body = { operationId, fields: { title: 'made before the revocation' } };
    const created = await asPerson('task.create', body, who.token);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect((await asPerson('task.create', body, who.token)).body).toStrictEqual(created.body);

    const revoked = await asPerson(
      'grant.revoke',
      { operationId: randomUUID(), grantId: who.write },
      managerToken,
    );
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    const replayed = await asPerson('task.create', body, who.token);
    expect(replayed.body['code']).toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(replayed.body)).not.toContain(String(created.body['recordId']));
    expect(await lastEvent(operationId)).toBe('refused/SCOPE_NOT_GRANTED');
  });
});
