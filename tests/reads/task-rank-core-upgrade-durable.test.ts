// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createEmptyDatabase, type EmptyDatabase } from '../support/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { ownedRankServer, appliedTask } from './task-rank-core-world.ts';
import {
  applyMigrations,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { taskSpineConformance } from '../../packages/core-records/src/tasks/conformance.ts';
import { domainModelConformance } from '../../packages/core-records/src/records/conformance.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { UncheckedRequest } from '../../packages/core-commands/src/commands/requests.ts';

const START_MIGRATION = '20261008120000_task_rank_started_at';
interface UpgradeWorld {
  readonly db: EmptyDatabase;
  readonly business: string;
  readonly owner: Member;
  readonly taskTypeId: string;
}
const command = async (w: UpgradeWorld, body: UncheckedRequest) =>
  await executeCommand(w.db.app, w.business, w.owner.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  });
async function page(w: UpgradeWorld, id: string) {
  const answer = await executeRead(w.db.app, w.business, w.owner.presented, {
    read: 'task.read',
    recordId: id,
  });
  if (isCommandRefusal(answer) || !('task' in answer)) throw new Error('Upgrade task.read refused');
  return answer.task;
}
async function fields(w: UpgradeWorld) {
  return await w.db.admin.execute(
    `select to_jsonb(f) as field from public.field_defs f
      where business_id = $1 and record_type_id = $2 and key <> 'started_at' order by key`,
    [w.business, w.taskTypeId],
  );
}
async function record(w: UpgradeWorld, id: string) {
  return await w.db.admin.execute(
    'select to_jsonb(r) as record from public.records r where business_id = $1 and id = $2',
    [w.business, id],
  );
}
async function installedBeforeDate(db: EmptyDatabase): Promise<UpgradeWorld> {
  const migrations = readMigrations('migrations');
  const index = migrations.findIndex((m) => m.version === START_MIGRATION);
  if (index <= 0) throw new Error('Start-date migration not found after an installed prefix');
  await applyMigrations(db.admin, migrations.slice(0, index));
  const business = await insertBusiness(db.app, `rankcore-upgrade-${randomUUID()}`);
  const spine = await installSpine(db.app, business);
  const owner = await enrol(db.app, business, 'rankcore-upgrade-owner');
  await db.app.withBusiness(business, async (tx) => {
    await grantTo(tx, owner, 'read');
    await grantTo(tx, owner, 'write');
  });
  return { db, business, owner, taskTypeId: spine.taskTypeId };
}
async function oldTask(w: UpgradeWorld) {
  const made = appliedTask(
    await command(w, {
      command: 'task.create',
      fields: { title: 'Synthetic task predating start-date metadata' },
    }),
  );
  const marked = appliedTask(
    await command(w, {
      command: 'task.set_scores',
      recordId: made.id,
      expectedRevision: made.revision,
      fields: { impact: 7, confidence: 9, ease: 8 },
    }),
  );
  // Normal existing upgrade-fixture pattern: install the complete spine, then
  // remove only the metadata that the before version did not declare. Actual
  // task creation/marks and all remaining metadata stay exactly as installed.
  await w.db.admin.execute(
    `delete from public.field_defs where business_id = $1 and record_type_id = $2 and key = 'started_at'`,
    [w.business, w.taskTypeId],
  );
  const missing = await w.db.admin.execute(
    `select key from public.field_defs where business_id = $1 and record_type_id = $2 and key = 'started_at'`,
    [w.business, w.taskTypeId],
  );
  expect(Array.from(missing)).toStrictEqual([]);
  return marked;
}
async function provePreservedUpgrade(w: UpgradeWorld, id: string) {
  const fieldsBefore = await fields(w);
  const recordBefore = await record(w, id);
  await w.db.closeSessions();
  const migrations = readMigrations('migrations');
  const migrated = await applyMigrations(w.db.admin, migrations);
  const start = migrations.findIndex((m) => m.version === START_MIGRATION);
  expect(migrated.applied).toStrictEqual(migrations.slice(start).map((m) => m.version));
  expect(await fields(w)).toStrictEqual(fieldsBefore);
  expect(await record(w, id)).toStrictEqual(recordBefore);
  const added = await w.db.admin.execute(
    `select value_type, slot, write_mode, visibility_class, origin from public.field_defs
      where business_id = $1 and record_type_id = $2 and key = 'started_at'`,
    [w.business, w.taskTypeId],
  );
  expect(Array.from(added)).toStrictEqual([
    {
      value_type: 'timestamptz',
      slot: null,
      write_mode: 'generic',
      visibility_class: 'internal',
      origin: 'core',
    },
  ]);
  const installed = await installSpine(w.db.app, w.business);
  expect(installed.taskTypeId).toBe(w.taskTypeId);
  expect(installed.installed).toBe(false);
  expect(await fields(w)).toStrictEqual(fieldsBefore);
  expect(await record(w, id)).toStrictEqual(recordBefore);
  expect(await taskSpineConformance(w.db.admin.execute.bind(w.db.admin))).toStrictEqual([]);
  expect(await domainModelConformance(w.db.admin.execute.bind(w.db.admin))).toStrictEqual([]);
}
async function proveUpgradedWrites(w: UpgradeWorld, id: string) {
  const before = await page(w, id);
  expect(before.startedAt).toBeNull();
  expect(before.rank.score).toBe(504);
  appliedTask(
    await command(w, {
      command: 'task.start',
      recordId: id,
      expectedRevision: before.revision,
    }),
  );
  const started = await page(w, id);
  expect(started.startedAt).toEqual(expect.any(String));
  appliedTask(
    await command(w, {
      command: 'task.update',
      recordId: id,
      expectedRevision: started.revision,
      fields: { started_at: new Date(Date.now() - 15 * 86_400_000).toISOString() },
    }),
  );
  const dated = await page(w, id);
  expect(dated.rank.score).toBe(554);
  const board = await executeRead(w.db.app, w.business, w.owner.presented, {
    read: 'task.board',
    board: null,
  });
  if (isCommandRefusal(board) || !('tasks' in board)) throw new Error('Upgrade task.board refused');
  expect(board.tasks.find((t) => t.id === id)?.rank).toStrictEqual(dated.rank);
}
it('an installed business at the old migration prefix gains start-date metadata without changing its task or fields, then real writes rank identically', async () => {
  const db = await createEmptyDatabase({
    serverUrl: ownedRankServer(),
    part: 'orch172_rankcore_upgrade',
  });
  try {
    const w = await installedBeforeDate(db);
    const old = await oldTask(w);
    const before = await page(w, old.id);
    expect(before.startedAt).toBeNull();
    expect(before.rank.score).toBe(504);
    expect(
      await command(w, {
        command: 'task.update',
        recordId: old.id,
        expectedRevision: old.revision,
        fields: { started_at: '2026-01-01T00:00:00.000Z' },
      }),
    ).toMatchObject({ refused: true, code: 'FIELD_UNKNOWN' });
    await provePreservedUpgrade(w, old.id);
    await proveUpgradedWrites(w, old.id);
    const after = await record(w, old.id);
    await db.closeSessions();
    expect((await applyMigrations(db.admin, readMigrations('migrations'))).applied).toStrictEqual(
      [],
    );
    expect(await record(w, old.id)).toStrictEqual(after);
  } finally {
    await db.drop();
  }
}, 180_000);
