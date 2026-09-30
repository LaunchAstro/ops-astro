// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's system runner: the job a worker runs under its lease once the gate has
// passed, composing the reviewed executable (`core-connectors`) with the
// records (`core-records`) in three steps:
//
// 1. Read the correction under the worker lease. Only an approved correction
//    publishes; an accepted one is observed again, never dispatched again; an
//    unknown one waits for reconciliation. A stored page the C18-1 fence
//    refuses stops the run here, before anything is read or sent
//    (`live-correction-capture.ts`).
// 2. Rebuild the exact approved bytes from the pinned source (the store keeps
//    digests, never text), then run the executable, which checks approval,
//    envelope, cancellation and drift before its one dispatch. The capture
//    reads the correction's own catalogued page through the fence, never a
//    provider's address.
// 3. Write the observed result with its receipt under the same lease. A lease
//    lost in between writes nothing and raises a task: the effect may have
//    happened, and the dispatch token keeps a later attempt the same effect.
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
  observeLanded,
  publishCorrection,
  type Accepted,
  type CaptureOptions,
  type CorrectionTarget,
  type ProviderResult,
  type PublishJob,
} from '../../../core-connectors/src/index.ts';
import {
  landedObservations,
  observedIn,
  pinnedObservations,
  seen,
  type Observations,
} from './live-correction-observations.ts';
import { captureFenced, pageNotCatalogued } from './live-correction-capture.ts';

export interface CorrectionRun {
  readonly business: string;
  readonly correctionId: string;
  readonly leaseId: string;
  readonly fence: number;
}

/** The provider calls, each a catalogued operation through the guarded call or the fence. */
export interface RunnerPorts {
  readonly readSource: () => Promise<ProviderResult<{ content: string; revision: string }>>;
  readonly publish: (input: {
    seam: string;
    dispatchToken: string;
    versionDigest: string;
  }) => Promise<ProviderResult<{ revision: string; deploymentId: string; liveUrl: string }>>;
  readonly readDeployment: (
    deploymentId: string,
  ) => Promise<ProviderResult<{ revision: string; served: boolean }>>;
  /** `site.capture`: the C18-1 fence's own inputs, never a function handed in. */
  readonly capture: CaptureOptions;
  readonly revert: (input: {
    seam: string;
  }) => Promise<ProviderResult<{ revision: string; deploymentId: string }>>;
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
export function targetOf(correction: LiveCorrection): CorrectionTarget {
  return {
    path: correction.targetPath,
    word: correction.word,
    replacement: correction.replacement,
  };
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
  if (code === undefined) return undefined;
  await ports.raiseTask(code);
  return { kind: 'refused', code, waitsOn: 'person' };
}

/** Cancellation is the correction's own state, read fresh: no lease needed to see it. */
async function cancellation(db: Database, run: CorrectionRun): Promise<'none' | 'requested'> {
  const rows = await db.withBusiness(
    run.business,
    async (tx) =>
      await tx.query<{ readonly state: string }>(
        `select state from public.live_corrections where business_id = $1 and id = $2`,
        [tx.businessId, run.correctionId],
      ),
  );
  return rows[0]?.state === 'cancelled' ? 'requested' : 'none';
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
    capture: async () => await captureFenced(correction.pageUrl, ports.capture),
  });
  return await record(
    db,
    run,
    {
      step: 'publish',
      outcome: landed.state,
      observations: {
        ...pinnedObservations(correction, ports.refusals()),
        ...landedObservations(correction, landed),
      },
    },
    ports,
  );
}

/** The accepted publish a receipt recorded, rebuilt for observing it again. */
function acceptedFrom(
  correction: LiveCorrection,
  last: Readonly<Record<string, unknown>> | undefined,
): Accepted | undefined {
  const revision = observedIn(last, 'published_revision');
  const deploymentId = observedIn(last, 'deployment_id');
  const dispatchToken = observedIn(last, 'attempt_and_dispatch_token');
  if (revision === undefined || deploymentId === undefined || dispatchToken === undefined)
    return undefined;
  return {
    state: 'accepted',
    revision,
    deploymentId,
    liveUrl: correction.pageUrl,
    dispatchToken,
  };
}

/** Step 2's rebuild: the approved change from the pinned source, or the refusal. */
async function rebuild(
  correction: LiveCorrection,
  ports: RunnerPorts,
): Promise<PublishJob | RunResult> {
  const approved = correction.decidedVersionDigest;
  if (correction.state !== 'approved' || approved === null) return refused('APPROVAL_MISSING');
  const source = await ports.readSource();
  if (source.kind !== 'ok') return refused('CONTENT_DRIFT_UNCHECKED');
  if (contentDigest(source.value.content) !== correction.preImageDigest) {
    await ports.raiseTask('CONTENT_DRIFTED');
    return { kind: 'refused', code: 'CONTENT_DRIFTED', waitsOn: 'person' };
  }
  const pin = {
    target: targetOf(correction),
    preImageDigest: correction.preImageDigest,
    baseRevision: correction.baseRevision,
    pageUrl: correction.pageUrl,
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
    seam: correction.seam,
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
  const outcome = await publishCorrection(job, {
    readSource: ports.readSource,
    publish: ports.publish,
    cancellation: async () => await cancellation(db, run),
    raiseTask: ports.raiseTask,
  });
  if (outcome.state === 'refused') {
    if (outcome.code === 'CONTENT_DRIFTED') await ports.raiseTask(outcome.code);
    return {
      kind: 'refused',
      code: outcome.code,
      ...(outcome.waitsOn ? { waitsOn: 'person' } : {}),
    };
  }
  if (outcome.state === 'accepted') return await observe(db, run, correction, outcome, ports);
  const observations: Observations = {
    ...pinnedObservations(correction, ports.refusals()),
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

/** Publish an approved correction, or observe an accepted one again. */
export async function runLivePublish(
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
  if (correction.state === 'unknown') return refused('OUTCOME_UNKNOWN');
  const unfenced = await pageRefused(correction, ports);
  if (unfenced !== undefined) return unfenced;
  if (correction.state === 'accepted') {
    const accepted = acceptedFrom(correction, held.lastPublish);
    if (accepted === undefined) return refused('OUTCOME_UNKNOWN');
    return await observe(db, run, correction, accepted, ports);
  }
  const job = await rebuild(correction, ports);
  if (!isJob(job)) return job;
  return await dispatch(db, run, correction, job, ports);
}
