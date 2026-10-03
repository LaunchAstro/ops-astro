// SPDX-License-Identifier: AGPL-3.0-only
//
// Receipt L's observations as the runner writes them: each one a value it
// looked at, as text, never a value the plan supplied (receipts.ts).

import type { LiveCorrection } from '../../../core-records/src/index.ts';
import type { Accepted } from '../../../core-connectors/src/index.ts';

export type Observations = Record<string, { readonly observed: string }>;

export function seen(value: string): { readonly observed: string } {
  return { observed: value };
}

/** One observation a receipt recorded, when it recorded one as text. */
export function observedIn(
  observations: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const entry = observations?.[key];
  const value =
    typeof entry === 'object' && entry !== null
      ? (entry as Record<string, unknown>)['observed']
      : undefined;
  return typeof value === 'string' ? value : undefined;
}

/** Receipt L's observations every publish receipt carries: what was pinned and approved. */
export function pinnedObservations(
  correction: LiveCorrection,
  refusals: readonly string[],
): Observations {
  return {
    pre_image_digest: seen(correction.preImageDigest),
    approved_version_digest: seen(correction.decidedVersionDigest ?? 'none'),
    gate_decision: seen(`approved version ${correction.versionId}`),
    refusals_raised: seen(refusals.length === 0 ? 'none recorded' : refusals.join(' ')),
  };
}

/** Receipt L's observations of an accepted publish and what was seen of it. */
export function landedObservations(
  correction: LiveCorrection,
  landed: Accepted | (Omit<Accepted, 'state'> & { readonly state: 'live' }),
): Observations {
  return {
    published_revision: seen(landed.revision),
    deployment_id: seen(landed.deploymentId),
    deployment_served: seen(landed.state === 'live' ? 'served' : 'not yet served'),
    ...(landed.state === 'live' ? { post_live_address: seen(correction.pageUrl) } : {}),
    attempt_and_dispatch_token: seen(landed.dispatchToken),
  };
}
