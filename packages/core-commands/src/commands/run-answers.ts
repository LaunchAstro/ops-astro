// SPDX-License-Identifier: AGPL-3.0-only
//
// `run.top_up` and `run.end_at_budget_stop`: a person's answers to a run
// waiting at its approved ceiling (AW-05), as commands over the runtime
// functions that own them (`core-runtime/src/budget-answer.ts`).

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import type { HandlerOutcome } from './outcome.ts';

export function topUpOnRun(
  _tx: TenantQuery,
  _context: CommandContext,
  _fields: {
    readonly recordId: unknown;
    readonly runId: unknown;
    readonly amountMinor: unknown;
    readonly currency: unknown;
  },
): Promise<HandlerOutcome> {
  return Promise.reject(new Error('run.top_up: not built'));
}

export function endOnRun(
  _tx: TenantQuery,
  _context: CommandContext,
  _fields: { readonly recordId: unknown; readonly runId: unknown },
): Promise<HandlerOutcome> {
  return Promise.reject(new Error('run.end_at_budget_stop: not built'));
}
