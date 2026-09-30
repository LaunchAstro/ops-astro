// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's revert runner (case 8): a live correction reverted forward, observed
// served and showing the original word, and only then timed. A revert that is
// accepted, unknown or failed leaves the page recorded live, with a receipt
// saying why, and an unknown raises a task.

import {
  readCorrectionForRun,
  type Database,
  type ReceiptOutcome,
} from '../../../core-records/src/index.ts';
import { revertCorrection, type RevertOutcome } from '../../../core-connectors/src/index.ts';
import { observedIn, seen, type Observations } from './live-correction-observations.ts';
import {
  captureFenced,
  record,
  refused,
  targetOf,
  type CorrectionRun,
  type RunnerPorts,
  type RunResult,
} from './live-correction-runner.ts';

const REVERT_OUTCOME: Readonly<Record<RevertOutcome['state'], ReceiptOutcome>> = {
  reverted: 'reverted',
  revert_accepted: 'accepted',
  unknown: 'unknown',
  failed: 'failed',
};

function revertObservations(outcome: RevertOutcome): Observations {
  if ('code' in outcome)
    return { refusals_raised: seen(outcome.code), decided_at: seen(outcome.decidedAt) };
  const common = {
    published_revision: seen(outcome.revision),
    deployment_id: seen(outcome.deploymentId),
    decided_at: seen(outcome.decidedAt),
  };
  if (outcome.state === 'revert_accepted') return common;
  return {
    ...common,
    observed_at: seen(outcome.observedAt),
    revert_interval_ms: seen(String(outcome.intervalMs)),
  };
}

/** Revert a live correction forward, observed and timed (case 8). */
export async function runLiveRevert(
  db: Database,
  run: CorrectionRun,
  ports: RunnerPorts,
): Promise<RunResult> {
  const held = await db.withBusiness(
    run.business,
    async (tx) => await readCorrectionForRun(tx, run),
  );
  if (!held.ok) return refused(held.code);
  const { correction } = held;
  const publishedRevision = observedIn(held.lastPublish, 'published_revision');
  if (correction.state !== 'live' || publishedRevision === undefined)
    return refused('GATE_NOT_APPROVED');
  const outcome = await revertCorrection(
    { publishedRevision, target: targetOf(correction), seam: correction.seam },
    {
      readDeployment: ports.readDeployment,
      revert: ports.revert,
      capture: async () => await captureFenced(correction.pageUrl, ports),
      now: ports.now,
    },
  );
  if (outcome.state === 'unknown') await ports.raiseTask(outcome.code);
  return await record(
    db,
    run,
    {
      step: 'revert',
      outcome: REVERT_OUTCOME[outcome.state],
      observations: revertObservations(outcome),
    },
    ports,
  );
}
