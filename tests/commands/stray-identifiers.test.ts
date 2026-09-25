// SPDX-License-Identifier: AGPL-3.0-only
//
// A stray identifier on the five untargeted writes the envelope never checked
// (architecture review d8746a2, observation 2).
//
// `refuseIrrelevantTarget` refuses an identifier field an untargeted command
// does not take, `COMMAND_BODY_INVALID` naming it, so a body whose identifier
// the server would quietly drop is answered rather than honoured in the
// caller's belief. `task.heartbeat`, `task.cancel`, `task.restart`,
// `grant.revoke` and `delegation.revoke` had no entry in its table and it
// returned early for them. Each case here sends a body that succeeds without
// the stray field, adds one, and expects the typed refusal with nothing
// written; the control case sends the same body without it and succeeds.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo } from './fixture.ts';
import { createControls, detailOf, type Controls } from '../api/controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** What the refusal must be, byte for byte in its fields. */
function strayRefusal(field: string) {
  return {
    status: 400,
    code: 'COMMAND_BODY_INVALID',
    names: [field],
  };
}

/** The parts of an answer the refusal is compared on. */
function shapeOf(answer: { status: number; body: Record<string, unknown> }) {
  return { status: answer.status, code: answer.body['code'], names: answer.body['names'] };
}

describe.skipIf(serverUrl === undefined)('stray identifiers on untargeted writes', () => {
  let c: Controls;

  beforeAll(async () => {
    c = await createControls('strayids');
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  async function liveLineage(): Promise<{ recordId: string; lineageId: string }> {
    const task = await c.createTask(`stray ${randomUUID()}`);
    const proposal = await c.propose(task.id, task.revision);
    return { recordId: task.id, lineageId: String(proposal['lineageId']) };
  }

  it('refuses a stray batchId on task.heartbeat and renews nothing', async () => {
    const task = await c.createTask('stray heartbeat');
    const reservationId = await c.approve(await c.propose(task.id, task.revision));
    const picked = await c.asPerson('task.pickup', { reservationId });
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);
    const leaseId = String(detailOf(picked)['leaseId']);
    const fence = Number(detailOf(picked)['fence']);
    const expiry = `select extract(epoch from expires_at)::text as n from public.leases where id = $1`;
    const before = await c.count(expiry, [leaseId]);

    const stray = await c.asPerson('task.heartbeat', { leaseId, fence, batchId: randomUUID() });
    expect(shapeOf(stray)).toStrictEqual(strayRefusal('batchId'));
    expect(await c.count(expiry, [leaseId])).toBe(before);

    const clean = await c.asPerson('task.heartbeat', { leaseId, fence });
    expect([clean.status, clean.body['code']]).toStrictEqual([200, undefined]);
  });

  it('refuses a stray batchId on task.cancel and leaves the lineage live', async () => {
    const { recordId, lineageId } = await liveLineage();
    const stray = await c.asPerson('task.cancel', {
      recordId,
      lineageId,
      reason: 'stray',
      batchId: randomUUID(),
    });
    expect(shapeOf(stray)).toStrictEqual(strayRefusal('batchId'));
    expect(
      await c.count(
        `select count(*)::text as n from public.proposal_lineages where id = $1 and state = 'live'`,
        [lineageId],
      ),
    ).toBe(1);

    const clean = await c.asPerson('task.cancel', { recordId, lineageId, reason: 'clean' });
    expect([clean.status, clean.body['code']]).toStrictEqual([200, undefined]);
  });

  it('refuses a stray batchId on task.restart and opens no lineage', async () => {
    const { recordId, lineageId } = await liveLineage();
    const cancelled = await c.asPerson('task.cancel', { recordId, lineageId, reason: 'first' });
    expect(cancelled.status).toBe(200);
    const lineages = `select count(*)::text as n from public.proposal_lineages where task_id = $1`;
    const before = await c.count(lineages, [recordId]);

    const stray = await c.asPerson('task.restart', { recordId, lineageId, batchId: randomUUID() });
    expect(shapeOf(stray)).toStrictEqual(strayRefusal('batchId'));
    expect(await c.count(lineages, [recordId])).toBe(before);

    const clean = await c.asPerson('task.restart', { recordId, lineageId });
    expect([clean.status, clean.body['code']]).toStrictEqual([200, undefined]);
  });

  it('refuses a stray recordId on grant.revoke and revokes nothing', async () => {
    const task = await c.createTask('stray grant');
    const reader = await enrol(c.fixture.db.app, c.fixture.business, 'task_reader');
    let grantId = '';
    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      grantId = await grantTo(tx, reader, 'read', { kind: 'record', id: task.id });
    });
    const live = `select count(*)::text as n from public.grants where id = $1 and revoked_at is null`;

    const stray = await c.asPerson('grant.revoke', { grantId, recordId: task.id });
    expect(shapeOf(stray)).toStrictEqual(strayRefusal('recordId'));
    expect(await c.count(live, [grantId])).toBe(1);

    const clean = await c.asPerson('grant.revoke', { grantId });
    expect([clean.status, clean.body['code']]).toStrictEqual([200, undefined]);
  });

  it('refuses a stray leaseId on delegation.revoke and revokes nothing', async () => {
    const task = await c.createTask('stray delegation');
    const picked = await c.pickup(await c.approve(await c.propose(task.id, task.revision)));
    const delegationId = String(picked['delegationId']);
    const leaseId = String(picked['leaseId']);
    const live = `select count(*)::text as n from public.delegations where id = $1 and revoked_at is null`;

    const stray = await c.asPerson('delegation.revoke', { delegationId, leaseId });
    expect(shapeOf(stray)).toStrictEqual(strayRefusal('leaseId'));
    expect(await c.count(live, [delegationId])).toBe(1);

    const clean = await c.asPerson('delegation.revoke', { delegationId });
    expect([clean.status, clean.body['code']]).toStrictEqual([200, undefined]);
  });
});
