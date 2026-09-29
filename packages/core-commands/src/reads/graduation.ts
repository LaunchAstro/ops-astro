// SPDX-License-Identifier: AGPL-3.0-only
//
// `connection.graduation` (MP-14-10a): not built yet.

import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import { refuseCommand, type CommandRefusal } from '../commands/refusal.ts';
import type { ReadResult } from './requests.ts';

export async function readConnectionGraduation(
  _tx: TenantQuery,
  _session: Session,
): Promise<ReadResult | CommandRefusal> {
  return await Promise.resolve(
    refuseCommand('DEPENDENCY_NOT_LANDED', ['MP-14-10a'], ['not built yet']),
  );
}
