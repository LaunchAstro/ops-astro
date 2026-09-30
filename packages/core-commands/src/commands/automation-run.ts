// SPDX-License-Identifier: AGPL-3.0-only
//
// C52-A's run start (U36): dispatch rechecks the activation and its standing
// approval under the activation's lock, then the worker writes the run through
// AW-01 J's `startOccurrenceRun`, told the approval and version by C52-A's own
// rows in the same transaction. A refusal writes nothing, and dispatch then
// records no dispatch. The worker calls
// `dispatchOccurrence(tx, id, occurrenceRunStarter(workerActorId))`.

import { readOccurrenceFacts, type RunStarter } from '../../../core-records/src/index.ts';
import { startOccurrenceRun } from './occurrence-run.ts';

/** The run starter for this worker's dispatch of an approved occurrence. */
export function occurrenceRunStarter(workerActorId: string): RunStarter {
  return async (tx, run) => {
    const started = await startOccurrenceRun(
      tx,
      { occurrenceId: run.occurrenceId, workerActorId },
      readOccurrenceFacts,
    );
    return started.ok ? started.value.runId : { refused: started.refusal.code };
  };
}
