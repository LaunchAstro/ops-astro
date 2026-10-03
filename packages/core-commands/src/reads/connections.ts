// SPDX-License-Identifier: AGPL-3.0-only
//
// `connection.fleet` (MP-14-7a): the connector fleet.

import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import { refuseCommand, type CommandRefusal } from '../commands/refusal.ts';
import type { ReadResult } from './requests.ts';

export async function readConnectionFleet(
  _tx: TenantQuery,
  _session: Session,
): Promise<ReadResult | CommandRefusal> {
  return await Promise.resolve(
    refuseCommand('DEPENDENCY_NOT_LANDED', ['connection.fleet'], ['Not built yet.']),
  );
}
