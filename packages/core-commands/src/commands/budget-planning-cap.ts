// SPDX-License-Identifier: AGPL-3.0-only
//
// `budget.set_planning_cap` (AW-04, U10): declared, not built yet.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import type { CommandRequest } from './requests.ts';
import { refuseCommand } from './refusal.ts';
import { refused, type HandlerOutcome } from './outcome.ts';

export function setPlanningCap(
  _tx: TenantQuery,
  _context: CommandContext,
  _request: CommandRequest & { readonly command: 'budget.set_planning_cap' },
): Promise<HandlerOutcome> {
  return Promise.resolve(
    refused(refuseCommand('DEPENDENCY_NOT_LANDED', ['budget.set_planning_cap'], ['Not built.'])),
  );
}
