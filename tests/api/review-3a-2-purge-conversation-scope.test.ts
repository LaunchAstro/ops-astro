// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-BATCH-2 #312, batch 3a, defect 2: task.purge faults on a
// conversation's scope key.
//
// 0092's conversations_scope_record_fkey references records (business_id,
// scope_record_id) with no on delete action, and core-records tasks/trash.ts
// purgeTrashedRecords neither counts a conversation's scope as a hold (it
// checks proposal_lineages, planned_runs, task_envelopes and leases only) nor
// clears the scope before it deletes the task. So a trashed, aged task that a
// conversation was opened on makes the purge's delete fault on the key, and
// the whole purge rolls back: every other aged task in the business, here U,
// is never purged.
//
// Red on 8cbd0e422 (batch 3a before its fix squash): the purge answers a fault, not 200, and U is still there.
// Green once the purge either holds a conversation-scoped task (lists T in
// `retained`) or clears or nulls the scope before the delete (lists T in
// `purgedIds`); either way U is purged and the purge applies.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeBusinessSetting } from '../../packages/core-records/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, started, type ConversationWorld } from './aw-03-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, one case
describe.skipIf(serverUrl === undefined)('REVIEW-3A-2 purge and a conversation scope', () => {
  let w: ConversationWorld;

  /** A task created through the API. */
  async function createdTask(title: string): Promise<string> {
    const created = await w.as(w.owner, 'task.create', { fields: { title } });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const id = (created.body as { recordId: string }).recordId;
    return id;
  }

  /** Trash a task through the API and age its trash an hour. */
  async function trash(id: string): Promise<void> {
    const read = await w.as(w.owner, 'task.read', { recordId: id });
    const revision = (read.body['task'] as { revision: number }).revision;
    const trashed = await w.as(w.owner, 'task.trash', {
      operationId: randomUUID(),
      recordId: id,
      expectedRevision: revision,
    });
    expect(trashed.status, JSON.stringify(trashed.body)).toBe(200);
    await w.fixture.db.admin.execute(
      `update public.records set deleted_at = now() - interval '1 hour' where id = $1`,
      [id],
    );
  }

  const present = async (ids: readonly string[]): Promise<Set<string>> =>
    new Set(
      (
        await w.fixture.db.admin.execute<{ readonly id: string }>(
          `select id::text as id from public.records where id = any ($1::uuid[])`,
          [ids],
        )
      ).map((row) => row.id),
    );

  beforeAll(async () => {
    w = await conversationWorld('rv3a2');
    await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      await grantTo(tx, w.owner, 'manage');
      // Window zero: all the trash is old enough. The row is owned by its
      // command since 0068 (MP-2-11), so the write names that command.
      const written = await writeBusinessSetting(tx, {
        key: 'retention_window_days',
        owningOperation: 'settings.set_retention_window',
        value: 0,
      });
      if (written === undefined || 'refused' in written) throw new Error('window not written');
    });
  }, 120_000);

  afterAll(async () => {
    await w?.drop();
  });

  it('REVIEW-3A-2: task.purge applies and purges another aged task when a trashed task is a conversation scope (today it faults on conversations_scope_record_fkey)', async () => {
    const t = await createdTask('the scoped task');
    const conversationId = await started(w, w.owner, {
      scope: { kind: 'task', id: t },
      body: 'About the scoped task.',
    });
    const u = await createdTask('another aged task');
    await trash(t);
    await trash(u);
    await w.age(conversationId, 10);
    expect(await present([t, u])).toStrictEqual(new Set([t, u]));

    const purge = await w.as(w.owner, 'task.purge', { operationId: randomUUID() });
    expect(purge.status, `task.purge answered ${JSON.stringify(purge.body)}`).toBe(200);
    const detail = (purge.body as { detail: Record<string, unknown> }).detail;
    const purgedIds = detail['purgedIds'] as readonly string[];
    const retained = detail['retained'] as readonly string[];
    expect(purgedIds).toContain(u);
    // T is either purged (its scope cleared) or listed as retained, never neither.
    expect(purgedIds.includes(t) !== retained.includes(t)).toBe(true);
    expect((await present([t, u])).has(u)).toBe(false);
  });
});
