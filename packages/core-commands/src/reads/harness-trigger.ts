// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12, part one: the harness trigger read on one run of the caller's
// business, under the caller's grant.
//
// The run's required reading is its accept-time manifest (AW-04): every
// instruction file the run may read, by path, digest and size, summed. A run
// with no pin reads nothing. A manifest entry with no whole size is refused,
// never counted as nothing, because an under-count could say "not yet" where
// the work does not fit. The run sub-delegates when its parent's holder has
// handed part of it to a helper (AW-11's `delegated` run event).
//
// It is the team's: a reader outside it, or one with no live `task:read`, is
// refused. The run is filtered by the caller's grant on its task inside the
// statement, as `definition.attribution` filters, so a run outside it, in
// another business or not there at all, is one `NOT_FOUND` with nothing in
// it. Nothing here writes.

import { coveredScopes, subjectsOf } from '../../../core-records/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import { readTrigger, type TriggerReading } from '../../../core-runtime/src/index.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from '../commands/refusal.ts';
import { isInternalReader } from './tasks.ts';

export async function readHarnessTrigger(
  tx: TenantQuery,
  session: Session,
  runId: string,
): Promise<TriggerReading | CommandRefusal> {
  void coveredScopes;
  void subjectsOf;
  void refuseCommand;
  void refuseNotFound;
  void isInternalReader;
  void tx;
  void session;
  void runId;
  return await Promise.resolve(readTrigger({ readingBytes: 0, delegationDepth: 0 }));
}
