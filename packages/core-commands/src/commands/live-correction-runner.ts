// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's system runner: the job a worker runs under its lease once the gate has
// passed, composing the reviewed executable (`core-connectors`) with the
// records (`core-records`) in three steps:
//
// 1. Read the correction under the worker lease, and ask the effect register
//    (`live-correction-effect.ts`) whether its publish happened. One the
//    register holds is observed again, never dispatched again; an unknown one
//    the register does not hold waits on a person. Only a correction a person
//    approved publishes. A stored page the C18-1 fence refuses stops the run
//    before anything is read or sent (`live-correction-capture.ts`).
// 2. Rebuild the exact approved bytes from the pinned source (the store keeps
//    digests, never text), then take the dispatch under the lease: in one
//    transaction the correction, still approved, moves to unknown with its
//    receipt. Only then does the executable read back and send, so a second
//    runner, in this process or another, finds it unknown and waits on a
//    person. The provider's acceptance is registered as soon as the executable
//    returns it, with the place its live check reads.
// 3. Write the observed result with its receipt under the same lease. A lease
//    lost in between writes no receipt and raises a task; the register still
//    holds the effect, so the next run observes it rather than sending it.
//
// No transaction is held open across a provider call. The revert (case 8) is
// `live-correction-revert.ts`, on the same helpers.

import {
  readCorrectionForRun,
  recordObservedResult,
  type Database,
  type LiveCorrection,
  type ObservedResult,
} from '../../../core-records/src/index.ts';
import {
  approvedChange,
  contentDigest,
  dispatchToken,
  observeLanded,
  publishCorrection,
  type Accepted,
  type CaptureOptions,
  type CorrectionTarget,
  type ProviderResult,
  type PublishJob,
  type ReadBack,
} from '../../../core-connectors/src/index.ts';
import {
  landedObservations,
  pinnedObservations,
  seen,
  type Observations,
} from './live-correction-observations.ts';
import { capturePort, pageNotCatalogued } from './live-correction-capture.ts';
import {
  acceptedOf,
  correctionEffectId,
  readCorrectionEffect,
  registerCorrectionEffect,
  takeDispatch,
} from './live-correction-effect.ts';

/** Where the worker stands: the correction, the lease and fence it holds, and its own actor. */
export interface CorrectionRun {
  readonly business: string;
  readonly correctionId: string;
  readonly leaseId: string;
  readonly fence: number;
  /** The lease's holder: the read and the receipt are refused to any other actor. */
  readonly actorId: string;
}

type Seamed = { readonly seam: string; readonly dispatchToken: string };
type Published = { revision: string; deploymentId: string; liveUrl: string };
type Deployed = { revision: string; deploymentId: string };

/** The provider calls, each a catalogued operation through the guarded call or the fence. */
export interface RunnerPorts {
  readonly readSource: () => Promise<ProviderResult<{ content: string; revision: string }>>;
  /** `site.request.read` by the seam. */
  readonly readBack: (input: Seamed) => Promise<ReadBack<Published>>;
  readonly publish: (
    input: Seamed & { versionDigest: string },
  ) => Promise<ProviderResult<Published>>;
  readonly readDeployment: (
    deploymentId: string,
  ) => Promise<ProviderResult<{ revision: string; served: boolean }>>;
  /** `site.capture`: the C18-1 fence's own inputs, never a function handed in. */
  readonly capture: CaptureOptions;
  /** `site.source.read` of the default branch head, for a revert. */
  readonly revertReadBack: (input: Seamed) => Promise<ReadBack<Deployed>>;
  /** `site.source.revert`, under the token derived from the published revision. */
  readonly revert: (input: Seamed) => Promise<ProviderResult<Deployed>>;
  readonly raiseTask: (reason: string) => Promise<void>;
  readonly now: () => number;
  /** Every refusal and unknown the guarded calls recorded on this run, by code. */
  readonly refusals: () => readonly string[];
}

export type RunResult =
  | { readonly kind: 'refused'; readonly code: string; readonly waitsOn?: 'person' }
  | { readonly kind: 'recorded'; readonly state: string; readonly receiptId: string }
  | { readonly kind: 'unrecorded'; readonly outcome: string; readonly code: string };

export function refused(code: string): RunResult {
  return { kind: 'refused', code };
}

/** A refusal that waits on a person, with its task raised. */
async function waiting(code: string, ports: RunnerPorts): Promise<RunResult> {
  await ports.raiseTask(code);
  return { kind: 'refused', code, waitsOn: 'person' };
}

/** The lease read's refusal: a narrowed delegation waits on its person to restore the grant. */
export async function leaseRefused(code: string, ports: RunnerPorts): Promise<RunResult> {
  return code === 'DELEGATION_NARROWED' ? await waiting(code, ports) : refused(code);
}

export function targetOf(correction: LiveCorrection): CorrectionTarget {
  return {
    path: correction.targetPath,
    word: correction.word,
    replacement: correction.replacement,
  };
}

/** The digest a person approved, only while the correction stands approved. */
function approvedDigest(correction: LiveCorrection): string | undefined {
  if (correction.state !== 'approved') return undefined;
  return correction.decidedVersionDigest ?? undefined;
}

/** Step 3: the observed result and its receipt, or a raised task when it cannot be written. */
export async function record(
  db: Database,
  run: CorrectionRun,
  result: Pick<ObservedResult, 'step' | 'outcome'> & { readonly observations: Observations },
  ports: RunnerPorts,
): Promise<RunResult> {
  const written = await db.withBusiness(
    run.business,
    async (tx) => await recordObservedResult(tx, { ...run, ...result }),
  );
  if (written.ok) return { kind: 'recorded', state: written.state, receiptId: written.receiptId };
  await ports.raiseTask('RECEIPT_NOT_WRITTEN');
  return { kind: 'unrecorded', outcome: result.outcome, code: written.code };
}

/** A stored page the fence refuses stops the run before anything is read or sent. */
export async function pageRefused(
  correction: LiveCorrection,
  ports: RunnerPorts,
): Promise<RunResult | undefined> {
  const code = pageNotCatalogued(correction.pageUrl, ports.capture);
  return code === undefined ? undefined : await waiting(code, ports);
}

/** An accepted publish observed again: its revision served and its word on the page. */
async function observe(
  db: Database,
  run: CorrectionRun,
  correction: LiveCorrection,
  accepted: Accepted,
  ports: RunnerPorts,
): Promise<RunResult> {
  const landed = await observeLanded(accepted, targetOf(correction), {
    readDeployment: ports.readDeployment,
    capture: capturePort(correction.pageUrl, ports.capture),
    raiseTask: async (reason) => await ports.raiseTask(reason),
  });
  const observations = {
    ...pinnedObservations(correction, ports.refusals()),
    ...landedObservations(correction, landed),
    effect_operation_id: seen(correctionEffectId(correction.id, 'publish')),
  };
  return await record(db, run, { step: 'publish', outcome: landed.state, observations }, ports);
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
  // Refused after the dispatch was taken: the correction stands unknown, for a person.
  if (outcome.state === 'refused') return await waiting(outcome.code, ports);
  if (outcome.state === 'accepted') {
    const { revision, deploymentId, occurrence } = outcome;
    const answer = { revision, deploymentId, dispatchToken: outcome.dispatchToken };
    const kept = occurrence === undefined ? answer : { ...answer, occurrence };
    if (!(await registerCorrectionEffect(db, run, correction, 'publish', kept)))
      await ports.raiseTask('EFFECT_NOT_REGISTERED');
    return await observe(db, run, correction, outcome, ports);
  }
  const observations: Observations = {
    ...pinnedObservations(correction, ports.refusals()),
    effect_operation_id: seen(correctionEffectId(correction.id, 'publish')),
    ...(outcome.state === 'failed'
      ? { refusals_raised: seen(`${outcome.code} ${outcome.proof}`) }
      : {
          attempt_and_dispatch_token: seen(outcome.dispatchToken),
          unknown_outcome_reconciliation: seen(
            `${outcome.code}, read back by ${outcome.reference}`,
          ),
        }),
  };
  return await record(db, run, { step: 'publish', outcome: outcome.state, observations }, ports);
}

/** The states a publish the register holds is observed again from, never sent again. */
const OBSERVED_AGAIN: ReadonlySet<LiveCorrection['state']> = new Set([
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
    return await observe(db, run, correction, accepted, ports);
  }
  if (correction.state === 'unknown' || correction.state === 'accepted')
    return refused('OUTCOME_UNKNOWN');
  const job = await rebuild(correction, ports);
  if (!isJob(job)) return job;
  return await dispatch(db, run, correction, job, ports);
}
