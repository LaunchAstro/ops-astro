// SPDX-License-Identifier: AGPL-3.0-only
//
// `secret.list` (C31). Not yet built: it refuses.

import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import { refuseCommand, type CommandRefusal } from '../commands/refusal.ts';
import type { ReadResult } from './requests.ts';

export async function listCustodySecrets(
  _tx: TenantQuery,
  _session: Session,
): Promise<ReadResult | CommandRefusal> {
  return await Promise.resolve(
    refuseCommand('DEPENDENCY_NOT_LANDED', ['secret.list'], ['Custody is not built on this head.']),
  );
}
