// SPDX-License-Identifier: AGPL-3.0-only
//
// Record-scoped work control and target-scoped revocation (authority review
// finding 3, standards S1, at 4757d72).
//
// Ledger line 37: "Current existing work-control authority; no new actor
// capability inferred". At 4757d72 `task.cancel` and `task.restart` were
// declared without an existing-record target, and the envelope used that same
// flag to choose the authority scope, so a person holding `write` on exactly
// the task could propose on it but not cancel or restart its lineage: only a
// business-wide writer could. `grant.revoke` and `delegation.revoke` had the
// same shape, asking business-wide `manage` before the handler's own
// target-specific ceiling ran. The fix separates the authority target from
// revision and locking in the declaration; it grants nobody anything wider.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, type Member } from './fixture.ts';
import { createControls, detailOf, PROPOSAL, type Controls } from '../api/controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('controls authorised on their own target', () => {
  let c: Controls;
  let writer: Member;
  let own: { id: string; revision: number };
  let sibling: { id: string; revision: number };

  beforeAll(async () => {
    c = await createControls('ctlscope');
    own = await c.createTask('the task the writer holds');
    sibling = await c.createTask('a sibling task the writer does not hold');
    writer = await enrol(c.fixture.db.app, c.fixture.business, 'task_writer');
    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      const scope = { kind: 'record' as const, id: own.id };
      await grantTo(tx, writer, 'read', scope);
      await grantTo(tx, writer, 'write', scope);
      await grantTo(tx, writer, 'manage', scope);
    });
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  async function lineageOn(task: { id: string; revision: number }): Promise<string> {
    const answer = await c.asPerson('task.propose', {
      recordId: task.id,
      expectedRevision: task.revision,
      ...PROPOSAL,
    });
    expect(answer.status).toBe(200);
    return String(detailOf(answer)['lineageId']);
  }

  it('lets a task-scoped writer propose, cancel and restart its own lineage', async () => {
    const proposed = await c.asPerson(
      'task.propose',
      { recordId: own.id, expectedRevision: own.revision, ...PROPOSAL },
      writer,
    );
    expect(proposed.status).toBe(200);
    const lineageId = String(detailOf(proposed)['lineageId']);

    const cancelled = await c.asPerson(
      'task.cancel',
      { recordId: own.id, lineageId, reason: 'mine to stop' },
      writer,
    );
    expect([cancelled.status, cancelled.body['code']]).toStrictEqual([200, undefined]);

    const restarted = await c.asPerson('task.restart', { recordId: own.id, lineageId }, writer);
    expect([restarted.status, restarted.body['code']]).toStrictEqual([200, undefined]);
  });

  it('refuses the same writer on a sibling task, before any lineage check', async () => {
    const lineageId = await lineageOn(sibling);
    const cancelled = await c.asPerson(
      'task.cancel',
      { recordId: sibling.id, lineageId, reason: 'not mine' },
      writer,
    );
    expect([cancelled.status, cancelled.body['code']]).toStrictEqual([403, 'SCOPE_NOT_GRANTED']);
    const restarted = await c.asPerson('task.restart', { recordId: sibling.id, lineageId }, writer);
    expect([restarted.status, restarted.body['code']]).toStrictEqual([403, 'SCOPE_NOT_GRANTED']);
    expect(
      await c.count(
        `select count(*)::text as n from public.proposal_lineages where id = $1 and state = 'live'`,
        [lineageId],
      ),
    ).toBe(1);
  });

  it('refuses a task-scoped writer naming its own task with a sibling lineage', async () => {
    const lineageId = await lineageOn(sibling);
    const crossed = await c.asPerson(
      'task.cancel',
      { recordId: own.id, lineageId, reason: 'reaching across' },
      writer,
    );
    expect(crossed.body['code']).toBe('LINEAGE_NOT_ON_TASK');
  });

  it('lets a task-scoped manager revoke a grant on that task and refuses one on a sibling', async () => {
    const reader = await enrol(c.fixture.db.app, c.fixture.business, 'task_reader');
    let onOwn = '';
    let onSibling = '';
    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      onOwn = await grantTo(tx, reader, 'read', { kind: 'record', id: own.id });
      onSibling = await grantTo(tx, reader, 'read', { kind: 'record', id: sibling.id });
    });

    const revoked = await c.asPerson('grant.revoke', { grantId: onOwn }, writer);
    expect([revoked.status, revoked.body['code']]).toStrictEqual([200, undefined]);

    const outside = await c.asPerson('grant.revoke', { grantId: onSibling }, writer);
    expect([outside.status, outside.body['code']]).toStrictEqual([403, 'SCOPE_NOT_GRANTED']);
    expect(
      await c.count(
        `select count(*)::text as n from public.grants where id = $1 and revoked_at is null`,
        [onSibling],
      ),
    ).toBe(1);
  });
});
