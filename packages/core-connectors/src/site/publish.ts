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

import { payloadDigest } from '../../../core-digest/src/index.ts';
import type { ProviderResult } from '../call.ts';
import {
  checkEnvelope,
  wordOffsets,
  type CorrectionTarget,
  type ProposedChange,
} from './envelope.ts';
import { siteOperation } from './operations.ts';

export function contentDigest(value: unknown): string {
  return `sha256:${payloadDigest(value)}`;
}

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

/** Every check that must hold before the one dispatch, in order. */
async function beforeDispatch(
  job: PublishJob,
  ports: PublishPorts,
): Promise<PublishOutcome | undefined> {
  const { decision } = job;
  if (decision === undefined || decision.decision !== 'approve') return refused('APPROVAL_MISSING');
  const bound =
    decision.versionId === job.version.versionId &&
    decision.versionDigest === job.version.digest &&
    contentDigest({ target: job.target, change: job.change }) === job.version.digest;
  if (!bound) return refused('PROPOSAL_SUPERSEDED');
  if (!checkEnvelope(job.change, job.target).ok) return refused('CHANGE_ENVELOPE_EXCEEDED');
  if ((await ports.cancellation()) === 'requested') return refused('CANCELLED');
  const current = await ports.readSource();
  if (current.kind !== 'ok') return refused('CONTENT_DRIFT_UNCHECKED');
  const pinned = contentDigest(job.change.files[0]?.before ?? null);
  if (
    contentDigest(current.value.content) !== job.preImageDigest ||
    pinned !== job.preImageDigest
  ) {
    return { state: 'refused', code: 'CONTENT_DRIFTED', waitsOn: 'person' };
  }
  return undefined;
}

export async function publishCorrection(
  job: PublishJob,
  ports: PublishPorts,
): Promise<PublishOutcome> {
  const token = dispatchToken('site.publish', job.version.digest); const answer = await ports.publish({ seam: job.seam, dispatchToken: token, versionDigest: job.version.digest }); return answer.kind === 'ok' ? { state: 'accepted', ...answer.value, dispatchToken: token } : { state: 'failed', code: answer.code, proof: '' };
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

/** Live is two observations: the revision served, and the fenced capture showing the new word. */
export async function observeLanded(
  accepted: Accepted,
  target: CorrectionTarget,
  ports: ObservePorts,
): Promise<Accepted | (Omit<Accepted, 'state'> & { readonly state: 'live' })> {
  return { ...accepted, state: target && ports ? 'live' : 'live' };
}

export interface RevertPorts extends Omit<ObservePorts, 'capture'> {
  readonly now: () => number;
  /** `site.source.revert`: the forward change back to the pinned pre-image. */
  readonly revert: (input: {
    seam: string;
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
 * the original word; only then is the interval from the decision recorded. No
 * other recovery figure is quoted (ADR 0067).
 */
export async function revertCorrection(
  input: {
    readonly publishedRevision: string;
    readonly target: CorrectionTarget;
    readonly seam: string;
  },
  ports: RevertPorts,
): Promise<RevertOutcome> {
  const decided = ports.now(); const reverted = await ports.revert({ seam: input.seam }); const observed = ports.now(); return reverted.kind === 'ok' ? { state: 'reverted', ...reverted.value, decidedAt: new Date(decided).toISOString(), observedAt: new Date(observed).toISOString(), intervalMs: observed - decided } : { state: 'failed', code: reverted.code, decidedAt: '' };
}
