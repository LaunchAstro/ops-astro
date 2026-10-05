// SPDX-License-Identifier: AGPL-3.0-only
//
// `connection.signal` (MP-14-8): grants, tripwires and the night round on
// Connections & signal. Not built yet.

import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import { refuseCommand, type CommandRefusal } from '../commands/refusal.ts';
import type { ReadResult } from './requests.ts';

export async function readConnectionSignal(
  _tx: TenantQuery,
  _session: Session,
): Promise<ReadResult | CommandRefusal> {
  return await Promise.resolve(
    refuseCommand('DEPENDENCY_NOT_LANDED', ['connection.signal'], ['Not built yet.']),
  );
}
