// SPDX-License-Identifier: AGPL-3.0-only
//
// #1294's move for `decision-evidence-binding.test.ts`: the owner, with the
// triggers off, moves an approved lineage and its runs from one task to
// another in one statement, leaving the signed decision, version and evidence
// pack as they were. The lineage and its runs still name one task together.

import { randomUUID } from 'node:crypto';
import { bearer, call, personPath, type World } from '../acceptance/world.ts';

const TABLES = ['proposal_lineages', 'planned_runs'] as const;

export async function moveLineageToTask(
  world: World,
  lineageId: string,
  taskId: string,
): Promise<void> {
  for (const table of TABLES) {
    // eslint-disable-next-line no-await-in-loop -- each table, in order
    await world.db.admin.execute(`alter table public.${table} disable trigger all`);
  }
  try {
    await world.db.admin.execute(
      `with lineage as (
         update public.proposal_lineages set task_id = $3
          where business_id = $1 and id = $2 returning id
       )
       update public.planned_runs set task_id = $3
        where business_id = $1 and lineage_id in (select id from lineage)`,
      [world.alpha, lineageId, taskId],
    );
  } finally {
    for (const table of TABLES) {
      // eslint-disable-next-line no-await-in-loop -- each table, in order
      await world.db.admin.execute(`alter table public.${table} enable trigger all`);
    }
  }
}

/** Mia's `task.read` body: a member reading every task, the internal reader #1294 names. */
export async function readAsMia(world: World, taskId: string): Promise<Record<string, unknown>> {
  const answer = await call(
    world.api,
    personPath('alpha', '/task/read'),
    { operationId: randomUUID(), recordId: taskId },
    bearer(world.mia.token),
  );
  return answer.body;
}
