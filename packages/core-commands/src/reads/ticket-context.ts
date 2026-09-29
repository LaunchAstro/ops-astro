// SPDX-License-Identifier: AGPL-3.0-only
//
// Work this ticket (API-4): not built yet; the named tests come first.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { TaskSpine } from '../commands/context.ts';

/** The ticket's bundle as stored, before anything is withheld. */
export interface TicketContextRow {
  readonly blockedBy: readonly unknown[];
  readonly thread: readonly unknown[];
}

export async function readTicketContext(
  _tx: TenantQuery,
  _spine: TaskSpine,
  _recordId: string,
): Promise<TicketContextRow | undefined> {
  return await Promise.resolve(undefined);
}
