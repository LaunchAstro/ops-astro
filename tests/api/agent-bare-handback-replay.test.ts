// SPDX-License-Identifier: AGPL-3.0-only
//
// A settled handback, replayed with no delegation credential, over HTTP.
//
// `authoriseReplay` in `agent-envelope.ts` releases a stored handback only to
// the credential that made it. With no credential at all the replay is what
// any bare agent call outside the queue and a pickup is (root ruling 6 in
// ROOT-906613f-RULINGS): `DELEGATION_EXCLUDES_OPERATION`, with nothing of the
// stored receipt in it. The route answers before any task data is read, and
// it changes nothing but the one refused audit row the attempt is owed.
//
// The control is the same operation replayed under the credential that made
// it, which still gets the stored settlement back. Nothing below weakens the
// settled-handback checks; it adds the one branch no case reached.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { createControls, detailOf, type Controls } from './controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** The fixes `NO_DELEGATION_FIXES` carries, word for word. */
const NO_DELEGATION_FIXES = [
  'Present the credential the pickup handed you.',
  'Before a pickup an agent login may only read task.queue and call task.pickup.',
];

describe.skipIf(serverUrl === undefined)('a bare task.handback replay over HTTP', () => {
  let c: Controls;

  beforeAll(async () => {
    c = await createControls('bhrp');
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  /** Everything the handback settled, read on the administrative connection. */
  async function settledState(ids: {
    delegationId: unknown;
    leaseId: unknown;
    reservationId: unknown;
    taskId: string;
  }): Promise<string> {
    const rows = await c.fixture.db.admin.execute<{ readonly state: string }>(
      `select jsonb_build_object(
          'delegation', (select to_jsonb(d) from public.delegations d where d.id = $1),
          'lease', (select to_jsonb(l) from public.leases l where l.id = $2),
          'reservation', (select to_jsonb(r) from public.reservations r where r.id = $3),
          'task', (select to_jsonb(t) from public.records t where t.id = $4),
          'reports', (select count(*) from public.handback_reports),
          'operations', (select count(*) from public.operations),
          'delegations', (select count(*) from public.delegations),
          'leases', (select count(*) from public.leases)
        )::text as state`,
      [ids.delegationId, ids.leaseId, ids.reservationId, ids.taskId],
    );
    return String(rows[0]?.state);
  }

  it('refuses the bare replay DELEGATION_EXCLUDES_OPERATION with nothing of the receipt, and changes nothing', async () => {
    const task = await c.createTask('a task an agent hands back, then replays bare');
    const reservationId = await c.approve(await c.propose(task.id, task.revision, 'bare_replay'));
    const picked = await c.pickup(reservationId);
    const credential = String(picked['credential']);

    const operationId = randomUUID();
    const body = {
      operationId,
      leaseId: picked['leaseId'],
      fence: picked['fence'],
      outcome: 'completed',
      report: { wrote: 'a draft handed back once' },
    };
    const handedBack = await c.asAgent('task.handback', body, credential);
    expect(handedBack.status).toBe(200);
    const settled = detailOf(handedBack);
    expect(settled['reservationState']).toBe('abandoned');
    const reportId = String(settled['reportId']);
    expect(reportId).toMatch(/^[0-9a-f-]{36}$/u);

    const ids = {
      delegationId: picked['delegationId'],
      leaseId: picked['leaseId'],
      reservationId,
      taskId: task.id,
    };
    const before = await settledState(ids);
    const refusedAudit = async (): Promise<number> =>
      await c.count(
        `select count(*)::text as n from public.audit_events
          where command = 'task.handback' and operation_id = $1 and outcome = 'refused'`,
        [operationId],
      );
    expect(await refusedAudit()).toBe(0);

    // The same operation, the same body, and no delegation header.
    const bare = await c.asAgent('task.handback', body);
    expect(bare.status).toBe(403);
    expect(bare.body).toEqual({
      refused: true,
      code: 'DELEGATION_EXCLUDES_OPERATION',
      names: ['task.handback'],
      fixes: NO_DELEGATION_FIXES,
    });
    const text = JSON.stringify(bare.body);
    for (const stored of [
      reportId,
      reservationId,
      task.id,
      String(picked['leaseId']),
      String(picked['delegationId']),
      credential,
      'abandoned',
      'a draft handed back once',
    ]) {
      expect(text).not.toContain(stored);
    }
    expect(bare.body['detail']).toBeUndefined();

    // Nothing the handback settled moved, and the register row stays as it
    // was. The attempt itself is recorded once, as refused.
    expect(await settledState(ids)).toBe(before);
    expect(await refusedAudit()).toBe(1);

    // The control: the credential that made it still gets its receipt back.
    const credentialed = await c.asAgent('task.handback', body, credential);
    expect(credentialed.status).toBe(200);
    expect(detailOf(credentialed)['reportId']).toBe(reportId);
    expect(detailOf(credentialed)['reservationState']).toBe('abandoned');
    expect(await settledState(ids)).toBe(before);
    expect(
      await c.count(
        `select count(*)::text as n from public.audit_events
          where command = 'task.handback' and operation_id = $1 and outcome = 'replayed'`,
        [operationId],
      ),
    ).toBe(1);
  });
});
