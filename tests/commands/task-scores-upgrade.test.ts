// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-9 marks command over an upgrade, split from task-scores.test.ts: a
// business that synced its own `impact` before the marks existed keeps it,
// moved aside, and the mark takes the key.

import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../support/fresh-database.ts';
import {
  applyMigrations,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import { enrol, grantTo, installSpine } from './fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandHandle } from '../../packages/core-commands/src/commands/register-store.ts';

const serverUrl = databaseUrlFromEnvironment();

type Request = Parameters<typeof executeCommand>[4];

if (serverUrl === undefined) {
  console.warn('task-scores: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

let db: EmptyDatabase | undefined;

afterAll(async () => {
  await db?.drop();
});

/**
 * A business at the migration before the marks, whose preset synced its own
 * `impact` as a note, with one task noted in it.
 */
async function notedBeforeTheMarks(
  migrations: ReturnType<typeof readMigrations>,
  marks: number,
): Promise<{
  business: string;
  taskTypeId: string;
  writer: Awaited<ReturnType<typeof enrol>>;
  noted: CommandHandle;
}> {
  db = await createEmptyDatabase({ part: 'sup' });
  await applyMigrations(db.admin, migrations.slice(0, marks));
  const business = await insertBusiness(db.app, 'task-scores-upgrade');
  const spine = await installSpine(db.app, business);
  const writer = await enrol(db.app, business, 'writer');
  await db.app.withBusiness(business, async (tx) => await grantTo(tx, writer, 'write'));
  // The installer here already declares the marks, so they are removed to
  // stand for a business installed before them, which then synced its own
  // `impact` as a note.
  await db.admin.execute(
    `delete from public.field_defs
      where business_id = $1 and record_type_id = $2
        and key in ('impact', 'confidence', 'ease')`,
    [business, spine.taskTypeId],
  );
  await db.admin.execute(
    `insert into public.field_defs
       (business_id, id, record_type_id, key, label, value_type, slot,
        write_mode, owning_operation, visibility_class, origin)
     values ($1, gen_random_uuid(), $2, 'impact', 'Impact note', 'text', null,
             'generic', null, 'internal', 'preset')`,
    [business, spine.taskTypeId],
  );
  const noted = await executeCommand(db.app, business, writer.presented, 'api', {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title: 'noted before the upgrade', impact: 'big for the launch' },
  } as unknown as Request);
  if (isCommandRefusal(noted)) throw new Error(`create refused ${noted.code}`);
  return { business, taskTypeId: spine.taskTypeId, writer, noted };
}

describe.skipIf(serverUrl === undefined)('MP-4-9 marks command over an upgrade', () => {
  it('moves a preset field already keyed impact aside, values and all', async () => {
    const migrations = readMigrations('migrations');
    const marks = migrations.findIndex((migration) => migration.version === '0042_task_marks');
    const { business, taskTypeId, writer, noted } = await notedBeforeTheMarks(migrations, marks);
    const upgraded = db as EmptyDatabase;

    await upgraded.closeSessions();
    await applyMigrations(upgraded.admin, migrations);

    const fields = await upgraded.admin.execute<{ readonly key: string; readonly origin: string }>(
      `select key, origin from public.field_defs
        where business_id = $1 and record_type_id = $2 and key like '%impact'
        order by key`,
      [business, taskTypeId],
    );
    expect(fields.map((row) => `${row.key}:${row.origin}`)).toStrictEqual([
      'impact:core',
      'preset_impact:preset',
    ]);
    const data = await upgraded.admin.execute<{ readonly data: Record<string, unknown> }>(
      `select data from public.records where business_id = $1 and id = $2`,
      [business, noted.recordId],
    );
    expect(data[0]?.data['preset_impact']).toBe('big for the launch');
    expect('impact' in (data[0]?.data ?? {})).toBe(false);

    const scored = await executeCommand(upgraded.app, business, writer.presented, 'api', {
      command: 'task.set_scores',
      operationId: randomUUID(),
      recordId: noted.recordId,
      expectedRevision: (noted.revision ?? 1) + 1,
      fields: { impact: 7 },
    } as unknown as Request);
    expect(isCommandRefusal(scored) ? scored.code : 'applied').toBe('applied');
  }, 180_000);
});
