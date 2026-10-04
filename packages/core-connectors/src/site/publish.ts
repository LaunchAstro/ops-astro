// SPDX-License-Identifier: AGPL-3.0-only
//
// The reviewed executable: the one place the live correction's real effect
// happens. It runs under the worker lease after the gate, and every step
// before the dispatch refuses rather than guesses (release decision
// sections 3 and 8):
//
// - no approving decision on the exact version: `APPROVAL_MISSING`;
// - a decision on another version, or bytes other than the approved ones:
//   `PROPOSAL_SUPERSEDED` (case 4);
// - anything wider than the envelope: `CHANGE_ENVELOPE_EXCEEDED` (case 9);
// - cancelled before dispatch: `CANCELLED`, nothing sent;
// - the file moved since its pre-image was pinned: `CONTENT_DRIFTED`, a wait
//   on a person, never an overwrite (case 5).
//
// After the dispatch the answer is `accepted` at most, never live (D21-5);
// an answer that cannot be read stays `unknown` with its reference and raises
// a task (case 6); a cancellation that arrives after the dispatch is an
// uncertain effect, not a cancellation (case 7). Live is a later observation.
// Every send reads its effect back through the seam first, so a retry of an
// unknown is never sent blind (broker contract 3.4).

import type { ProviderResult } from '../call.ts';
import { checkEnvelope, type CorrectionTarget, type ProposedChange } from './envelope.ts';
import {
  claimed,
  occurrenceOf,
  proven,
  reconciled,
  showsAt,
  type Occurrence,
  type ReadBack,
} from './reconcile.ts';
import { contentDigest, versionDigestOf } from './version.ts';

/** The provider's idempotency key: stable for one intended effect across retries (broker contract 3.4). */
export function dispatchToken(operation: string, versionDigest: string): string {
  return contentDigest({ operation, versionDigest });
}

export interface GateDecision {
  readonly decisionId: string;
  readonly decision: 'approve' | 'reject' | 'request_changes';
  readonly versionId: string;
  readonly versionDigest: string;
}

export interface PublishJob {
  readonly correctionId: string;
  readonly target: CorrectionTarget;
  readonly change: ProposedChange;
  /** The target file's digest at the pinned revision, taken before the proposal was composed. */
  readonly preImageDigest: string;
  readonly baseRevision: string;
  /** The catalogued page the correction was asked for; the capture reads this and nothing else. */
  readonly pageUrl: string;
  readonly version: { readonly versionId: string; readonly digest: string };
  readonly decision: GateDecision | undefined;
  /** The reference the publish is read back by, held before dispatch. */
  readonly seam: string;
}

export interface Published {
  readonly revision: string;
  readonly deploymentId: string;
  readonly liveUrl: string;
}

export interface PublishPorts {
  /** `site.source.read` of the target file on the branch being published. */
  readonly readSource: () => Promise<ProviderResult<{ content: string; revision: string }>>;
  /** `site.request.read` by the seam: absent only while the request is provably unmerged. */
  // The wiring must return landed only when the merged head is the approved one, else unknown.
  readonly readBack: (input: {
    seam: string;
    dispatchToken: string;
  }) => Promise<ReadBack<Published>>;
  /** `site.publish`, once. */
  readonly publish: (input: {
    seam: string;
    dispatchToken: string;
    versionDigest: string;
  }) => Promise<ProviderResult<Published>>;
  readonly cancellation: () => Promise<'none' | 'requested'>;
  readonly raiseTask: (reason: string) => Promise<void>;
}

export type PublishRefusal =
  | 'APPROVAL_MISSING'
  | 'PROPOSAL_SUPERSEDED'
  | 'CHANGE_ENVELOPE_EXCEEDED'
  | 'CANCELLED'
  | 'CONTENT_DRIFTED'
  | 'CONTENT_DRIFT_UNCHECKED';

export interface Accepted extends Published {
  readonly state: 'accepted';
  readonly dispatchToken: string;
  readonly occurrence: Occurrence | undefined;
}

export type PublishOutcome =
  | { readonly state: 'refused'; readonly code: PublishRefusal; readonly waitsOn?: 'person' }
  | Accepted
  | { readonly state: 'failed'; readonly code: string; readonly proof: string }
  | {
      readonly state: 'unknown';
      readonly code: string;
      readonly reference: string;
      readonly dispatchToken: string;
    };

const refused = (code: PublishRefusal): PublishOutcome => ({ state: 'refused', code });

/** Every check before the one dispatch, in order; drift counts only while nothing has landed. */
async function beforeDispatch(
  job: PublishJob,
  ports: PublishPorts,
  back: ReadBack<Published>,
): Promise<PublishOutcome | undefined> {
  const { decision } = job;
  if (decision === undefined || decision.decision !== 'approve') return refused('APPROVAL_MISSING');
  const bound =
    decision.versionId === job.version.versionId &&
    decision.versionDigest === job.version.digest &&
    versionDigestOf(job) === job.version.digest;
  if (!bound) return refused('PROPOSAL_SUPERSEDED');
  if (!(await checkEnvelope(job.change, job.target)).ok) return refused('CHANGE_ENVELOPE_EXCEEDED');
  if (back.state !== 'absent') return undefined;
  const current = await ports.readSource();
  if (current.kind !== 'ok') return refused('CONTENT_DRIFT_UNCHECKED');
  const pinned = contentDigest(job.change.files[0]?.before ?? null);
  if (
    contentDigest(current.value.content) !== job.preImageDigest ||
    pinned !== job.preImageDigest
  ) {
    return { state: 'refused', code: 'CONTENT_DRIFTED', waitsOn: 'person' };
  }
  // Last, after every awaited read: a cancellation that arrived during one still stops the send.
  return (await ports.cancellation()) === 'requested' ? refused('CANCELLED') : undefined;
}

export async function publishCorrection(
  job: PublishJob,
  ports: PublishPorts,
): Promise<PublishOutcome> {
  const token = dispatchToken('site.publish', job.version.digest);
  const readBack = () => ports.readBack({ seam: job.seam, dispatchToken: token });
  const send = () =>
    ports.publish({ seam: job.seam, dispatchToken: token, versionDigest: job.version.digest });
  const answer = await claimed(job.seam, token, async () => {
    const back = await readBack();
    return (await beforeDispatch(job, ports, back)) ?? (await reconciled(back, send, readBack));
  });
  if ('state' in answer) return answer;
  const unknown = async (code: string): Promise<PublishOutcome> => {
    await ports.raiseTask(code);
    return { state: 'unknown', code, reference: job.seam, dispatchToken: token };
  };
  if ((await ports.cancellation()) === 'requested') return unknown('CANCELLED_AFTER_DISPATCH');
  if (answer.kind === 'ok') {
    const occurrence = occurrenceOf(job.change, job.target);
    return { state: 'accepted', ...answer.value, dispatchToken: token, occurrence };
  }
  if (proven('site.publish', answer)) {
    return { state: 'failed', code: answer.code, proof: answer.proof };
  }
  return unknown(answer.code);
}

export interface Served {
  readonly revision: string;
  readonly served: boolean;
}

export interface ObservePorts {
  /** `site.deployment.read`. */
  readonly readDeployment: (deploymentId: string) => Promise<ProviderResult<Served>>;
  /** `site.capture` of the public address, through the fence. */
  readonly capture: (
    url: string,
  ) => Promise<
    { readonly ok: true; readonly value: { readonly text: string } } | { readonly ok: false }
  >;
}

/** Live is two observations: the revision served, and the fenced capture showing the new word where it was approved. */
export async function observeLanded(
  accepted: Accepted,
  target: CorrectionTarget,
  ports: ObservePorts,
): Promise<Accepted | (Omit<Accepted, 'state'> & { readonly state: 'live' })> {
  const deployment = await ports.readDeployment(accepted.deploymentId);
  const served =
    deployment.kind === 'ok' &&
    deployment.value.served &&
    deployment.value.revision === accepted.revision;
  if (!served) return accepted;
  const captured = await ports.capture(accepted.liveUrl);
  const where = accepted.occurrence;
  if (!captured.ok || !showsAt(captured.value.text, where, target.replacement, target.word)) {
    return accepted;
  }
  return { ...accepted, state: 'live' };
}

export interface RevertPorts extends Omit<ObservePorts, 'capture'> {
  readonly now: () => number;
  /** `site.source.read` of the default branch head: absent only while it provably holds no revert. */
  readonly readBack: (input: {
    seam: string;
    dispatchToken: string;
  }) => Promise<ReadBack<{ revision: string; deploymentId: string }>>;
  /** `site.source.revert`: the forward change back to the pinned pre-image. */
  readonly revert: (input: {
    seam: string;
    dispatchToken: string;
  }) => Promise<ProviderResult<{ revision: string; deploymentId: string }>>;
  readonly capture: () => Promise<
    { readonly ok: true; readonly value: { readonly text: string } } | { readonly ok: false }
  >;
}

export type RevertOutcome =
  | {
      readonly state: 'reverted';
      readonly revision: string;
      readonly deploymentId: string;
      readonly decidedAt: string;
      readonly observedAt: string;
      readonly intervalMs: number;
    }
  | {
      readonly state: 'revert_accepted';
      readonly revision: string;
      readonly deploymentId: string;
      readonly decidedAt: string;
    }
  | { readonly state: 'unknown' | 'failed'; readonly code: string; readonly decidedAt: string };

/**
 * Case 8: the revert is published forward, observed served, and the page shows
 * the original word at the approved occurrence; only then is the interval from
 * the decision recorded. No other recovery figure is quoted (ADR 0067).
 */
export async function revertCorrection(
  input: {
    readonly publishedRevision: string;
    readonly target: CorrectionTarget;
    /** The approved change being reverted: it places the occurrence the page is observed at. */
    readonly change: ProposedChange;
    readonly seam: string;
    /** When the revert was decided, kept across every resumed attempt until it is observed. */
    readonly decidedAt: number;
  },
  ports: RevertPorts,
): Promise<RevertOutcome> {
  const decidedAt = new Date(input.decidedAt).toISOString();
  // One token per published revision, and a retry is read back before it is ever sent again.
  const token = dispatchToken('site.source.revert', input.publishedRevision);
  const readBack = () => ports.readBack({ seam: input.seam, dispatchToken: token });
  const send = () => ports.revert({ seam: input.seam, dispatchToken: token });
  const reverted = await claimed(input.seam, token, async () =>
    reconciled(await readBack(), send, readBack),
  );
  if (reverted.kind !== 'ok') {
    const state = proven('site.source.revert', reverted) ? 'failed' : 'unknown';
    return { state, code: reverted.code, decidedAt };
  }
  const { revision, deploymentId } = reverted.value;
  const pending = { state: 'revert_accepted', revision, deploymentId, decidedAt } as const;
  const deployment = await ports.readDeployment(deploymentId);
  const served =
    deployment.kind === 'ok' && deployment.value.served && deployment.value.revision === revision;
  if (!served) return pending;
  const captured = await ports.capture();
  const { word, replacement } = input.target;
  const where = occurrenceOf(input.change, input.target);
  if (!captured.ok || !showsAt(captured.value.text, where, word, replacement)) return pending;
  const observed = ports.now();
  return {
    state: 'reverted',
    revision,
    deploymentId,
    decidedAt,
    observedAt: new Date(observed).toISOString(),
    intervalMs: observed - input.decidedAt,
  };
}
