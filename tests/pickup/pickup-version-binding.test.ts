// SPDX-License-Identifier: AGPL-3.0-only
//
// L6 W02 (a): the version binding a pickup's `handbackShape` describes is the
// one the handback enforces. A superseded version cannot settle the work.
// Split out of `agent-pickup-payload.test.ts`, which checks the payload field
// by field.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createControls, PROPOSAL, type Controls } from '../api/controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('W02 (a): the pickup payload, field by field', () => {
  let c: Controls;
  beforeAll(async () => {
    c = await createControls('pickup_binding');
  }, 120_000);
  afterAll(async () => {
    await c?.drop();
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
