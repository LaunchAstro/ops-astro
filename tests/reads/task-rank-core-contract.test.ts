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

it('the task start-date metadata migration follows the latest installed migration IDs', () => {
  const versions = readMigrations('migrations').map((one) => one.version);
  const at = versions.indexOf('20261008120000_task_rank_started_at');
  expect(versions.slice(at - 1, at + 2)).toStrictEqual([
    '20261007174205_run_reference_scopes',
    '20261008120000_task_rank_started_at',
    '20261009060000_priority_stages',
  ]);
});
