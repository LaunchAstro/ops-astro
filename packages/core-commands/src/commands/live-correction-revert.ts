// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's revert runner (case 8): a live correction reverted forward, observed
// served and showing the original word, and only then timed. A revert that is
// accepted, unknown or failed leaves the page recorded live, with a receipt
// saying why, and an unknown raises a task.
//
// The revert rides the effect register as the publish does: the revision it
// reverts is the publish the register holds, and the provider's acceptance is
// registered the moment it answers, with the time it was decided. A revert the
// register holds is observed again and timed from that decision, never sent
// again; an unknown revert the register does not hold waits on a person. So
// that a revert whose answer never reached the register is never sent blind
// again, its receipt says unknown under the lease before it is sent.

import {
  readCorrectionForRun,
  recordObservedResult,
  type Database,
  type LiveCorrection,
  type ReceiptOutcome,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import { revertCorrection, type RevertOutcome } from '../../../core-connectors/src/index.ts';
import { seen, type Observations } from './live-correction-observations.ts';
import { captureFenced } from './live-correction-capture.ts';
import {
  correctionEffectId,
  readCorrectionEffect,
  registerCorrectionEffect,
  revertLeftUnknown,
  type RegisteredEffect,
} from './live-correction-effect.ts';
import {
  pageRefused,
  record,
  refused,
  targetOf,
  type CorrectionRun,
  type RunnerPorts,
  type RunResult,
} from './live-correction-runner.ts';

type RevertPorts = Parameters<typeof revertCorrection>[1];

const REVERT_OUTCOME: Readonly<Record<RevertOutcome['state'], ReceiptOutcome>> = {
  reverted: 'reverted',
  revert_accepted: 'accepted',
  unknown: 'unknown',
  failed: 'failed',
};

function revertObservations(outcome: RevertOutcome, operationId: string): Observations {
  if ('code' in outcome)
    return {
      refusals_raised: seen(outcome.code),
      decided_at: seen(outcome.decidedAt),
      effect_operation_id: seen(operationId),
    };
  const common = {
    effect_operation_id: seen(operationId),
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

/** The correction, its publish and revert as the register holds them, under the lease. */
async function readForRevert(tx: TenantQuery, run: CorrectionRun) {
  const read = await readCorrectionForRun(tx, run);
  if (!read.ok) return read;
  const { correction } = read;
  return {
    ...read,
    published: await readCorrectionEffect(tx, correction, 'publish'),
    reverted: await readCorrectionEffect(tx, correction, 'revert'),
    leftUnknown: await revertLeftUnknown(tx, correction.id),
  };
}

/**
 * The provider's revert, registered the moment it answers with the time it was
 * decided; or, when the register already holds it, that answer again, decided
 * when it was, so it is observed and timed and never sent twice.
 */
function revertPorts(
  db: Database,
  run: CorrectionRun,
  held: { readonly correction: LiveCorrection; readonly reverted?: RegisteredEffect },
  ports: RunnerPorts,
): RevertPorts {
  const { correction, reverted } = held;
  const common = {
    readDeployment: ports.readDeployment,
    capture: async () => await captureFenced(correction.pageUrl, ports.capture),
  };
  if (reverted !== undefined) {
    let first: number | undefined = Date.parse(reverted.decidedAt ?? '');
    return {
      ...common,
      revert: () =>
        Promise.resolve({
          kind: 'ok',
          value: { revision: reverted.revision, deploymentId: reverted.deploymentId },
        }),
      now: () => {
        const decided = first;
        first = undefined;
        return decided !== undefined && Number.isFinite(decided) ? decided : ports.now();
      },
    };
  }
  let decidedAt = '';
  return {
    ...common,
    revert: async (input) => {
      const answer = await ports.revert(input);
      if (answer.kind !== 'ok') return answer;
      const registered = { ...answer.value, decidedAt };
      if (!(await registerCorrectionEffect(db, run, correction, 'revert', registered)))
        await ports.raiseTask('EFFECT_NOT_REGISTERED');
      return answer;
    },
    now: () => {
      const instant = ports.now();
      if (decidedAt === '') decidedAt = new Date(instant).toISOString();
      return instant;
    },
  };
}

/**
 * The revert's receipt, unknown, under the lease before an unregistered revert
 * is sent: a lease or worker lost before its answer is registered leaves the
 * next run waiting on a person. A later receipt or the register overrides it.
 */
async function unknownUntilAnswered(db: Database, run: CorrectionRun, correctionId: string) {
  const observations = { effect_operation_id: seen(correctionEffectId(correctionId, 'revert')) };
  return await db.withBusiness(
    run.business,
    async (tx) =>
      await recordObservedResult(tx, { ...run, step: 'revert', outcome: 'unknown', observations }),
  );
}

/** Revert a live correction forward, observed and timed (case 8). */
export async function runLiveRevert(
  db: Database,
  run: CorrectionRun,
  ports: RunnerPorts,
): Promise<RunResult> {
  const held = await db.withBusiness(run.business, async (tx) => await readForRevert(tx, run));
  if (!held.ok) return refused(held.code);
  const { correction, published, reverted } = held;
  if (correction.state !== 'live' || published === undefined) return refused('GATE_NOT_APPROVED');
  if (reverted === undefined && held.leftUnknown) return refused('OUTCOME_UNKNOWN');
  const unfenced = await pageRefused(correction, ports);
  if (unfenced !== undefined) return unfenced;
  if (reverted === undefined) {
    const marked = await unknownUntilAnswered(db, run, correction.id);
    if (!marked.ok) return refused(marked.code);
  }
  const outcome = await revertCorrection(
    { publishedRevision: published.revision, target: targetOf(correction), seam: correction.seam },
    revertPorts(db, run, { correction, ...(reverted ? { reverted } : {}) }, ports),
  );
  if (outcome.state === 'unknown') await ports.raiseTask(outcome.code);
  return await record(
    db,
    run,
    {
      step: 'revert',
      outcome: REVERT_OUTCOME[outcome.state],
      observations: revertObservations(outcome, correctionEffectId(correction.id, 'revert')),
    },
    ports,
  );
}
