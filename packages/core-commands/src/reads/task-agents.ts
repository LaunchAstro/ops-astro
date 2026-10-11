// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent assignee as `task.read` sends it (Assign to AI): the board's
// reading (`board-agents.ts`) of the one task.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import { NO_AGENTS, readBoardAgents, type RowAgents } from './board-agents.ts';

/** The task's agent and the reader's choices for it; neither for an agent reader (null). */
export async function readTaskAgents(
  tx: TenantQuery,
  recordId: string,
  reader: string | null,
): Promise<RowAgents> {
  return (await readBoardAgents(tx, [recordId], reader)).get(recordId) ?? NO_AGENTS;
}
