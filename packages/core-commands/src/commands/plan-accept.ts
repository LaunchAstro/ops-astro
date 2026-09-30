// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.accept_plan`: a person's one click on the plan's gate (AW-04). Not built yet.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import type { HandlerOutcome } from './outcome.ts';

export interface AcceptFields {
  readonly gateId: string;
  readonly versionId: string;
  readonly note: string;
  readonly planText: unknown;
  readonly plan: unknown;
  readonly entryPath: unknown;
  readonly paths: unknown;
  readonly conversationId?: string | null;
}

export function acceptPlanOnGate(
  _tx: TenantQuery,
  _context: CommandContext,
  _fields: AcceptFields,
): Promise<HandlerOutcome> {
  throw new Error('task.accept_plan: not built');
}
