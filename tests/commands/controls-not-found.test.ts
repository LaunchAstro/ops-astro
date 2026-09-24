// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.cancel` and `task.restart` answer a task or a lineage that is not
// there with the one `NOT_FOUND` the rest of the surface gives
// (`refuseNotFound` in `commands/refusal.ts`), both fix lines of it, not a
// truncated copy (THERMO-RECHECK-2 M5). The names still say which operand
// named nothing, as they did.
//
// The transaction is a stub that answers "no row" or one row, so this is a
// pure unit suite and must not be named in `tests/db/named-suites.json`.

import { describe, expect, it } from 'vitest';
import {
  cancelOnTask,
  restartOnTask,
} from '../../packages/core-records/src/commands/tasks-controls.ts';
import {
  isRefused,
  type HandlerOutcome,
} from '../../packages/core-records/src/commands/outcome.ts';
import { refuseNotFound } from '../../packages/core-records/src/commands/refusal.ts';
import type { CommandContext } from '../../packages/core-records/src/commands/context.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';

const TASK = '3f1d2f3a-0000-4000-8000-000000000001';
const LINEAGE = '3f1d2f3a-0000-4000-8000-000000000002';

/** A transaction holding the task or not, and never the lineage. */
function holding(task: boolean): TenantQuery {
  return {
    businessId: '3f1d2f3a-0000-4000-8000-0000000000b1',
    query: async (sql: string) =>
      await Promise.resolve(sql.includes('from public.records') && task ? [{ id: TASK }] : []),
  } as unknown as TenantQuery;
}

const context = { spine: { taskTypeId: 'task-type' } } as unknown as CommandContext;

function refusalOf(outcome: HandlerOutcome) {
  if (!isRefused(outcome)) throw new Error('expected a refusal');
  return outcome.refusal;
}

const cases = [
  {
    what: 'a malformed task identifier',
    task: false,
    recordId: 'nope',
    lineageId: LINEAGE,
    names: [],
  },
  { what: 'a task that is not there', task: false, recordId: TASK, lineageId: LINEAGE, names: [] },
  {
    what: 'a malformed lineage identifier',
    task: true,
    recordId: TASK,
    lineageId: 'nope',
    names: ['lineageId'],
  },
  {
    what: 'a lineage that is not there',
    task: true,
    recordId: TASK,
    lineageId: LINEAGE,
    names: ['lineageId'],
  },
] as const;

describe('the lineage controls answer NOT_FOUND in the surface words', () => {
  it.each(cases)('task.cancel: $what', async ({ task, recordId, lineageId, names }) => {
    const refusal = refusalOf(
      await cancelOnTask(holding(task), context, { recordId, lineageId, reason: 'not needed' }),
    );
    expect(refusal).toStrictEqual({ ...refuseNotFound(), names });
  });

  it.each(cases)('task.restart: $what', async ({ task, recordId, lineageId, names }) => {
    const refusal = refusalOf(await restartOnTask(holding(task), context, { recordId, lineageId }));
    expect(refusal).toStrictEqual({ ...refuseNotFound(), names });
  });
});
