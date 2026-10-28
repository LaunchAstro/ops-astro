// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner's carry of a review's pins (#2166, C35-X; `docs/local/SITE-RUNNER.md`,
// "Review captures"): when a capture's land answers `carryDue`, the runner calls
// `review.carry_pins` for that revision under the same lease, in the same pass, as a call of
// its own, so the land never carries and the carry's audit is its own operation. The API judges
// the lease again after the carry's last lock wait. A carry refused or never answered fails the
// pass (`PinsUncarried`), as an unclaimed capture does; only its code is printed.

import { printable, type AgentCall } from './claims.ts';

/** A due carry refused, or with no usable answer: the pass fails on it, as on an unclaimed capture. */
export class PinsUncarried extends Error {
  /** The refusal's code as it may be printed, or `CARRY_FAULT`. */
  readonly code: string;

  constructor(code: string) {
    super(`the carry ended ${code}`);
    this.name = 'PinsUncarried';
    this.code = code;
  }
}

/** Carry the review's pins onto `revisionId` under the lease: nothing once applied, else why not. */
export async function carryPins(
  call: AgentCall,
  lease: { readonly leaseId: string; readonly fence: number; readonly pickup: string },
  revisionId: string,
): Promise<PinsUncarried | undefined> {
  const { leaseId, fence, pickup } = lease;
  const carried = await call('review.carry_pins', { leaseId, fence, revisionId }, pickup).catch(
    () => ({ fault: true }) as const,
  );
  if ('detail' in carried) return undefined;
  return new PinsUncarried('refused' in carried ? printable(carried.refused) : 'CARRY_FAULT');
}
