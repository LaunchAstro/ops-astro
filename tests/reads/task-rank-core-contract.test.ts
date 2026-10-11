// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { readMigrations } from '../../packages/core-records/src/tenancy/migrate.ts';
import { TASK_SPINE } from '../../packages/core-records/src/tasks/spine.ts';

it('R70 task start date is an internal nullable typed field with the normal task writer', () => {
  expect(TASK_SPINE.find((field) => field.key === 'started_at')).toMatchObject({
    key: 'started_at',
    valueType: 'timestamptz',
    slot: null,
    writeMode: 'generic',
    owningOperations: [],
    visibilityClass: 'internal',
  });
});

it('the task start-date metadata migration follows the migration IDs installed before it', () => {
  const versions = readMigrations('migrations').map((m) => m.version);
  const index = versions.indexOf('20261008120000_task_rank_started_at');
  expect(index).toBeGreaterThan(0);
  expect(versions[index - 1]).toBe('20261007174205_run_reference_scopes');
});
