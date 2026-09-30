// SPDX-License-Identifier: AGPL-3.0-only
//
// D06's positive body for the agent's `run.revise_state` (MP-6-2): the held
// work's run at its newest version, so each cell's control applies. Kept
// beside `d06-agent.test.ts` so that file stays under its cap.

import type { World } from './world.ts';

export async function revisedState(
  world: World,
  held: { readonly taskId: string; readonly attemptId: string },
): Promise<Record<string, unknown>> {
  const [run] = await world.db.admin.execute<{ readonly run_id: string; readonly version: number }>(
    `select att.run_id, (select coalesce(max(version), 0)::int from public.run_states s
        where s.run_id = att.run_id) as version
       from public.attempts att where att.id = $1`,
    [held.attemptId],
  );
  return {
    recordId: held.taskId,
    runId: run?.run_id,
    expectedVersion: run?.version,
    knowledge: ['the agent knows'],
    unknowns: [],
  };
}
