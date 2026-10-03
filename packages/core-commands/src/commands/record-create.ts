// SPDX-License-Identifier: AGPL-3.0-only
//
// `record.create` (C41-A, U38's one record-create command, RC-13): the named
// tests come first, so it answers that it has not landed until it is built.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { notLanded } from './onboarding.ts';
import type { HandlerOutcome } from './outcome.ts';

export async function createRecord(
  _tx: TenantQuery,
  _context: CommandContext,
  _request: { readonly type?: unknown; readonly fields: Readonly<Record<string, unknown>> },
): Promise<HandlerOutcome> {
  return await Promise.resolve(notLanded());
}
