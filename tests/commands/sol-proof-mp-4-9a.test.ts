// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  applyMigrations,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../support/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine } from './fixture.ts';

it('Sol proof, criterion 3: agent marks tests precede their implementation', () => {
  const firstTestCommit = execFileSync(
    'git',
    [
      'log',
      '--reverse',
      '--format=%H',
      '5cf315a9ea33feeffd739be8feb1096a07743ad0..HEAD',
      '--',
      'tests/commands/task-scores.test.ts',
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')[0];
  expect(firstTestCommit).toBeTruthy();
  const firstVersion = execFileSync(
    'git',
    ['show', `${firstTestCommit}:tests/commands/task-scores.test.ts`],
    { encoding: 'utf8' },
  );
  expect(firstVersion.includes("it('sets the marks on its own picked-up task")).toBe(true);
  expect(firstVersion.includes("it('cannot reach a task outside its delegation")).toBe(true);
});

it('Sol proof, criterion 4: marks isolation names business, client and person crossings', () => {
  const suite = readFileSync('tests/commands/task-scores.test.ts', 'utf8');
  for (const boundary of ['business to business', 'client to client', 'person to person']) {
    expect(
      suite.includes(`MP-4-9a isolation: ${boundary}`),
      `no named marks-command test crosses ${boundary}`,
    ).toBe(true);
  }
});

describe.skipIf(databaseUrlFromEnvironment() === undefined)('MP-4-9a upgrade proof', () => {
  let db: EmptyDatabase | undefined;

  afterAll(async () => {
    await db?.drop();
  });

  it('Sol proof, criterion 7: an upgraded task with a pre-existing impact field can set its mark', async () => {
    const migrations = readMigrations('migrations');
    const markIndex = migrations.findIndex((migration) => migration.version === '0032_task_marks');
    expect(markIndex).toBeGreaterThan(0);
    db = await createEmptyDatabase({ part: 'sol49a' });
    await applyMigrations(db.admin, migrations.slice(0, markIndex));

    const business = await insertBusiness(db.app, 'sol-mark-upgrade');
    const spine = await installSpine(db.app, business);
    const writer = await enrol(db.app, business, 'writer');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, writer, 'write');
    });

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
       values ($1, gen_random_uuid(), $2, 'impact', 'Old impact note', 'text', null,
               'generic', null, 'internal', 'preset')`,
      [business, spine.taskTypeId],
    );

    await db.closeSessions();
    await applyMigrations(db.admin, migrations);

    const created = await executeCommand(db.app, business, writer.presented, 'api', {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'upgraded task' },
    });
    if (isCommandRefusal(created)) throw new Error(`create refused ${created.code}`);
    const result = await executeCommand(db.app, business, writer.presented, 'api', {
      command: 'task.set_scores',
      operationId: randomUUID(),
      recordId: created.recordId ?? '',
      expectedRevision: created.revision ?? 1,
      fields: { impact: 7 },
    });
    expect(isCommandRefusal(result) ? result.code : 'applied').toBe('applied');
  }, 180_000);
});
