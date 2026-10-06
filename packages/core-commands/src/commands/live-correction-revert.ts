// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's revert runner (case 8): a live correction reverted forward, observed
// served and showing the original word, and only then timed. A revert that is
// accepted, unknown or failed leaves the page recorded live, with a receipt
// saying why, and an unknown raises a task.
//
// The revert rides the effect register as the publish does: the revision it
// reverts is the publish the register holds, the page must return to the place
// the publish was seen live at (its live receipt), and the provider's
// acceptance is registered the moment it answers, with the time the runner
// first took the revert up (the job carries no decision time, so the interval
// runs from there, not from a person's decision). A revert the register holds
// is observed again and timed from that instant, never sent again; an unknown
// revert the register does not hold waits on a person, asked once. So
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
import {
  observedIn,
  occurrenceFrom,
  seen,
  targetOf,
  type Observations,
} from './live-correction-observations.ts';
import { capturePort } from './live-correction-capture.ts';
import {
  correctionEffectId,
  readCorrectionEffect,
  registerCorrectionEffect,
  latestRevert,
  type RegisteredEffect,
} from './live-correction-effect.ts';
import {
  leaseRefused,
  pageRefused,
  record,
  refused,
  unknownWaits,
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
      // An unknown raised its task: later runs do not ask again.
      ...(outcome.state === 'unknown' ? { waits_on: seen('person') } : {}),
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
  const live = observedIn(read.lastPublish, 'live_occurrence');
  return {
    ...read,
    occurrence: live === undefined ? undefined : occurrenceFrom(parsed(live)),
    published: await readCorrectionEffect(tx, correction, 'publish'),
    reverted: await readCorrectionEffect(tx, correction, 'revert'),
    last: await latestRevert(tx, correction.id),
  };
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The provider's revert, registered the moment it answers with the time it was first taken up;
 * or, when the register already holds it, read back as landed, so it is observed and
 * timed and never sent twice.
 */
function revertPorts(
  db: Database,
  run: CorrectionRun,
  held: { readonly correction: LiveCorrection; readonly reverted: RegisteredEffect | undefined },
  decidedAt: string,
  ports: RunnerPorts,
): RevertPorts {
  const { correction, reverted } = held;
  const common = {
    readDeployment: ports.readDeployment,
    capture: capturePort(correction.pageUrl, ports.capture),
    raiseTask: async (reason: string) => await ports.raiseTask(reason),
    now: ports.now,
  };
  if (reverted !== undefined) {
    const value = { revision: reverted.revision, deploymentId: reverted.deploymentId };
    const landed = { state: 'landed', value } as const;
    return {
      ...common,
      readBack: () => Promise.resolve(landed),
      revert: () => Promise.resolve({ kind: 'ok', value }),
    };
  }
  return {
    ...common,
    readBack: ports.revertReadBack,
    revert: async (input) => {
      const answer = await ports.revert(input);
      if (answer.kind !== 'ok') return answer;
      const registered = { ...answer.value, decidedAt };
      if (!(await registerCorrectionEffect(db, run, correction, 'revert', registered)))
        await ports.raiseTask('EFFECT_NOT_REGISTERED');
      return answer;
    },
  };
}

/**
 * The revert taken under the lease: in one transaction, the correction row locked by the read,
 * it is still live with no revert registered or left unknown, and its receipt says unknown
 * before the send. Of two runners only the first takes it; a lease or worker lost before the
 * answer is registered leaves the next run waiting on a person.
 */
async function takeRevert(db: Database, run: CorrectionRun, correctionId: string) {
  const observations = { effect_operation_id: seen(correctionEffectId(correctionId, 'revert')) };
  return await db.withBusiness(run.business, async (tx) => {
    const read = await readCorrectionForRun(tx, run);
    if (!read.ok) return read;
    const taken =
      read.correction.state !== 'live' ||
      (await latestRevert(tx, correctionId))?.outcome === 'unknown' ||
      (await readCorrectionEffect(tx, read.correction, 'revert')) !== undefined;
    if (taken) return { ok: false, code: 'OUTCOME_UNKNOWN' } as const;
    return await recordObservedResult(tx, {
      ...run,
      step: 'revert',
      outcome: 'unknown',
      observations,
    });
  });
}

/** Revert a live correction forward, observed and timed (case 8). */
export async function runLiveRevert(
  db: Database,
  run: CorrectionRun,
  ports: RunnerPorts,
): Promise<RunResult> {
  const held = await db.withBusiness(run.business, async (tx) => await readForRevert(tx, run));
  if (!held.ok) return await leaseRefused(held.code, ports);
  const { correction, published, reverted } = held;
  if (correction.state !== 'live' || published === undefined) return refused('GATE_NOT_APPROVED');
  if (reverted === undefined && held.last?.outcome === 'unknown') {
    return await unknownWaits(db, run, { step: 'revert', outcome: 'unknown' }, ports);
  }
  const unfenced = await pageRefused(correction, ports);
  if (unfenced !== undefined) return unfenced;
  if (reverted === undefined) {
    const marked = await takeRevert(db, run, correction.id);
    if (!marked.ok) return await leaseRefused(marked.code, ports);
  }
  const decided = Date.parse(reverted?.decidedAt ?? '');
  const decidedAt = Number.isFinite(decided) ? decided : ports.now();
  const input = {
    publishedRevision: published.revision,
    target: targetOf(correction),
    occurrence: held.occurrence,
    seam: correction.seam,
    decidedAt,
  };
  const iso = new Date(decidedAt).toISOString();
  const outcome = await revertCorrection(
    input,
    revertPorts(db, run, { correction, reverted }, iso, ports),
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
