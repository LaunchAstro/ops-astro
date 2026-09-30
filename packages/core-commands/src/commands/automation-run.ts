// SPDX-License-Identifier: AGPL-3.0-only
//
// The run C52-A's dispatch starts for an occurrence (U36): not built yet.

import { randomUUID } from 'node:crypto';
import type { RunStarter } from '../../../core-records/src/index.ts';

export function occurrenceRunStarter(_workerActorId: string): RunStarter {
  return async () => await Promise.resolve(randomUUID());
}
