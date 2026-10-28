// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { readMigrations } from '../../packages/core-records/src/tenancy/migrate.ts';
import { PROTECTED_TASK_FIELDS } from '../../packages/core-records/src/tasks/spine.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { TARGET_FREE } from '../acceptance/cd-target-free.ts';

// These counts also appear in database conformance. Check the repository
// contracts here so the counts do not wait for a database to run.
it('the task spine names twenty-seven protected fields', () => {
  expect(PROTECTED_TASK_FIELDS).toHaveLength(27);
});

it('the carriage upgrade contains four migrations in its reserved interval', () => {
  const carriage = readMigrations('migrations').filter(
    (migration) => migration.version >= '20261013010000' && migration.version < '20261013010400',
  );
  expect(carriage).toHaveLength(4);
});

it('the exported catalogue contains the 186 operations covered by the audit matrix', () => {
  expect(COMMAND_SURFACE).toHaveLength(186);
});

it('the timing matrix covers 122 identifier-bearing operations', () => {
  const targetFree = new Set(TARGET_FREE.map(([name]) => name));
  expect(COMMAND_SURFACE.filter((entry) => !targetFree.has(entry.name))).toHaveLength(122);
});
