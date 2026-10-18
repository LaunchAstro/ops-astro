// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's system runner: the job a worker runs under its lease once the gate has
// passed, composing the reviewed executable (`core-connectors`) with the records:
// 1. Read the correction under the lease and ask the effect register (`live-correction-effect.ts`)
//    whether its publish happened. One it holds is observed again, never sent again; an unknown
//    one it does not hold waits on a person, asked once. Only a correction a person approved
//    publishes, and a stored page the C18-1 fence refuses stops the run first.
// 2. Rebuild the exact approved bytes from the pinned source, then take the
//    dispatch under the lease (approved moves to unknown with its receipt), so a
//    second runner finds it unknown. A check that refuses after the take proves
//    nothing was sent and settles it failed. An acceptance is registered with the
//    place its live check reads.
// 3. Write the observed result with its receipt under the same lease. A lease
//    lost in between writes no receipt and raises a task; the register still
//    holds the effect, so the next run observes it rather than sending it.
//    An acceptance whose deployment the provider shows no record of yet is not
//    published yet: it stays accepted, and each later pass looks the deployment
//    up again by its commit until the host's last pass asks a person (#1696).
// No transaction is held open across a provider call.

import {
  readCorrectionForRun,
  type Database,
  type LiveCorrection,
} from '../../../core-records/src/index.ts';
import {
  approvedChange,
  checkEnvelope,
  contentDigest,
  dispatchToken,
  observeLanded,
  publishCorrection,
  type Accepted,
  type Observed,
  type PublishJob,
} from '../../../core-connectors/src/index.ts';
import {
  landedObservations,
  notAccepted,
  pinnedObservations,
  seen,
  targetOf,
  type Observations,
} from './live-correction-observations.ts';
import { capturePort } from './live-correction-capture.ts';
import {
  acceptedOf,
  correctionEffectId,
  readCorrectionEffect,
  registerCorrectionEffect,
  takeDispatch,
} from './live-correction-effect.ts';
import {
  leaseRefused,
  pageRefused,
  record,
  refused,
  unknownWaits,
  waiting,
  type CorrectionRun,
  type RunnerPorts,
  type RunResult,
} from './live-correction-run.ts';

/** The digest a person approved, only while the correction stands approved. */
const approvedDigest = (correction: LiveCorrection): string | undefined =>
  correction.state === 'approved' ? (correction.decidedVersionDigest ?? undefined) : undefined;

/** How the host runs a pass: its last pass, at its cap, ends a deployment still not found. */
export interface PassOptions {
  readonly lastPass?: boolean;
}

/** The accepted publish's deployment: as accepted, else looked up again by its revision. */
const deploymentOf = async (accepted: Accepted, ports: RunnerPorts) =>
  accepted.deploymentId === undefined
    ? await ports.findDeployment(accepted.revision)
    : ({ kind: 'ok', value: accepted.deploymentId } as const);

type Seen = Accepted | Observed<'live'> | Observed<'unknown'>;

/** Step 3 for an accepted publish as seen on this pass: unknown is not serving, for a person. */
async function recordSeen(
  db: Database,
  run: CorrectionRun,
  correction: LiveCorrection,
  landed: Seen,
  ports: RunnerPorts,
): Promise<RunResult> {
  const unserved = landed.state === 'unknown';
  const observations = {
    ...pinnedObservations(correction, ports.refusals()),
    ...landedObservations(correction, unserved ? { ...landed, state: 'accepted' } : landed),
    ...(unserved ? { deployment_served: seen('not serving'), waits_on: seen('person') } : {}),
    effect_operation_id: seen(correctionEffectId(correction.id, 'publish')),
  };
  return await record(db, run, { step: 'publish', outcome: landed.state, observations }, ports);
}

/**
 * An accepted publish observed again: its deployment found, its revision served and its word on
 * the page. None found yet stays accepted (not published yet) until the host's last pass, which
 * asks a person once; one found for another commit is unknown.
 */
async function observe(
  db: Database,
  run: CorrectionRun,
  correction: LiveCorrection,
  accepted: Accepted,
  ports: RunnerPorts,
  options: PassOptions,
): Promise<RunResult> {
  const found = await deploymentOf(accepted, ports);
  if (found.kind !== 'ok') {
    await ports.raiseTask(found.code);
    return await recordSeen(db, run, correction, { ...accepted, state: 'unknown' }, ports);
  }
  if (found.value === undefined && options.lastPass === true) {
    const at = { step: 'publish', outcome: 'unknown' } as const;
    return await unknownWaits(db, run, at, ports, 'DEPLOYMENT_NOT_FOUND');
  }
  if (found.value === undefined) return await recordSeen(db, run, correction, accepted, ports);
  const landed = await observeLanded(
    { ...accepted, deploymentId: found.value },
    targetOf(correction),
    {
      readDeployment: ports.readDeployment,
      capture: capturePort(correction.pageUrl, ports.capture),
      raiseTask: async (reason) => await ports.raiseTask(reason),
    },
  );
  return await recordSeen(db, run, correction, landed, ports);
}

/** Step 2's rebuild: the approved change from the pinned source, or the refusal. */
async function rebuild(
  correction: LiveCorrection,
  ports: RunnerPorts,
): Promise<PublishJob | RunResult> {
  const approved = approvedDigest(correction);
  if (approved === undefined) return refused('APPROVAL_MISSING');
  const unfenced = await pageRefused(correction, ports);
  if (unfenced !== undefined) return unfenced;
  const source = await ports.readSource();
  if (source.kind !== 'ok') return refused('CONTENT_DRIFT_UNCHECKED');
  if (contentDigest(source.value.content) !== correction.preImageDigest) {
    return await waiting('CONTENT_DRIFTED', ports);
  }
  const pin = {
    target: targetOf(correction),
    preImageDigest: correction.preImageDigest,
    baseRevision: correction.baseRevision,
    pageUrl: correction.pageUrl,
    seam: correction.seam,
  };
  const change = approvedChange(pin, source.value.content, approved);
  if (change === undefined) return refused('PROPOSAL_SUPERSEDED');
  if (!checkEnvelope(change, pin.target).ok) return refused('CHANGE_ENVELOPE_EXCEEDED');
  return {
    ...pin,
    correctionId: correction.id,
    change,
    version: { versionId: correction.versionId, digest: correction.versionDigest },
    decision: {
      decisionId: correction.id,
      decision: 'approve',
      versionId: correction.versionId,
      versionDigest: approved,
    },
  };
}

const isJob = (value: PublishJob | RunResult): value is PublishJob => 'change' in value;

/** Step 2's dispatch, then step 3 for whatever the executable established. */
async function dispatch(
  db: Database,
  run: CorrectionRun,
  correction: LiveCorrection,
  job: PublishJob,
  ports: RunnerPorts,
  options: PassOptions,
): Promise<RunResult> {
  const token = dispatchToken('site.publish', job.version.digest);
  const taken = await takeDispatch(db, run, token, approvedDigest);
  if (taken !== undefined) return await leaseRefused(taken, ports);
  const outcome = await publishCorrection(job, {
    readSource: ports.readSource,
    readBack: ports.readBack,
    publish: ports.publish,
    // Taken, the correction is unknown, which storage never moves to cancelled.
    cancellation: () => Promise.resolve('none'),
    raiseTask: async (reason) => await ports.raiseTask(reason),
    capture: capturePort(correction.pageUrl, ports.capture),
  });
  // Every refusal comes before the send: nothing went out, so the take is settled as failed.
  if (outcome.state === 'refused') await ports.raiseTask(outcome.code);
  if (outcome.state === 'accepted') {
    const { revision, deploymentId, occurrence } = outcome;
    const answer = {
      revision,
      ...(deploymentId === undefined ? {} : { deploymentId }),
      dispatchToken: outcome.dispatchToken,
    };
    const kept = occurrence === undefined ? answer : { ...answer, occurrence };
    if (!(await registerCorrectionEffect(db, run, correction, 'publish', kept)))
      await ports.raiseTask('EFFECT_NOT_REGISTERED');
    return await observe(db, run, correction, outcome, ports, options);
  }
  const refusals = ports.refusals();
  const observations: Observations = {
    ...pinnedObservations(correction, refusals),
    effect_operation_id: seen(correctionEffectId(correction.id, 'publish')),
    ...notAccepted(outcome, refusals),
  };
  const state = outcome.state === 'refused' ? 'failed' : outcome.state;
  return await record(db, run, { step: 'publish', outcome: state, observations }, ports);
}

/** The states a publish the register holds is observed again from, never sent again. */
const OBSERVED_AGAIN: ReadonlySet<string> = new Set([
  'approved',
  'accepted',
  'unknown',
  'cancelled',
]);

/** Publish an approved correction, or observe again one the register holds. */
export async function runLivePublish(
  db: Database,
  run: CorrectionRun,
  ports: RunnerPorts,
  options: PassOptions = {},
): Promise<RunResult> {
  const held = await db.withBusiness(run.business, async (tx) => {
    const read = await readCorrectionForRun(tx, run);
    if (!read.ok) return read;
    return { ...read, effect: await readCorrectionEffect(tx, read.correction, 'publish') };
  });
  if (!held.ok) return await leaseRefused(held.code, ports);
  const { correction, effect } = held;
  if (OBSERVED_AGAIN.has(correction.state) && effect !== undefined) {
    const accepted = acceptedOf(correction, effect);
    if (accepted === undefined) return refused('OUTCOME_UNKNOWN');
    const unfenced = await pageRefused(correction, ports);
    if (unfenced !== undefined) return unfenced;
    return await observe(db, run, correction, accepted, ports, options);
  }
  if (correction.state === 'unknown' || correction.state === 'accepted') {
    const unfenced = await pageRefused(correction, ports);
    if (unfenced !== undefined) return unfenced;
    return await unknownWaits(db, run, { step: 'publish', outcome: correction.state }, ports);
  }
  const job = await rebuild(correction, ports);
  if (!isJob(job)) return job;
  return await dispatch(db, run, correction, job, ports, options);
}
