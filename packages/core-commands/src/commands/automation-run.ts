// SPDX-License-Identifier: AGPL-3.0-only
//
// C52-A's run start (U36): the starter the worker hands dispatch for an
// approved occurrence. Not yet wired to AW-01 J's write.

import { randomUUID } from 'node:crypto';
import type { RunStarter } from '../../../core-records/src/index.ts';

/** The run starter for this worker's dispatch of an approved occurrence. */
export function occurrenceRunStarter(_workerActorId: string): RunStarter {
  return async () => await Promise.resolve(randomUUID());
}
