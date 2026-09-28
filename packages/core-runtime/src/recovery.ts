// SPDX-License-Identifier: AGPL-3.0-only
//
// T5: the bounded unstarted-attempt classifier.
//
// What it is not is most of the definition. It is not a worker, not a general
// sweeper, not a top-up, not a write-off and not an effect activation. It is
// invoked from inside the authorised operations that create the durable
// transitions it reads — completed handback, cancellation, rejection or
// supersession, recorded authority loss, and the fencing of an expired lease —
// and `classifyUnderLocks` takes no lock of its own, because its caller is
// holding the complete set already.
//
// **Eligibility is a recorded cause, never a clock.** Startup, elapsed time
// without an accepted expiry, a missing claimant and `lease_id = null` are all
// explicitly not abandonment triggers (T5). An approved, unleased, currently
// authorised reservation stays held across a crash and remains pickupable;
// that case is the one the whole classifier exists to leave alone.
//
// **A marker or an observation always retains the full hold.** Even when the
// work is otherwise terminal, a dispatch marker or an observation means
// something happened that this head has no reachable path to, so the hold is
// quarantined and named for a later reconciliation owner. Work refusal must
// never erase a real liability.
//
// The module is three files: `recovery/classifier.ts` (the classifier and the
// reads that find what it classifies), `recovery/lease-retirement.ts` (the
// live work a closing transition ends, and cancellation) and
// `recovery/authority-loss.ts` (the grants a claim rests on, and what a
// revocation classifies). This file is their one surface.

export {
  affectedByVersions,
  classifyUnderLocks,
  classifyVersions,
  checkAuthorityAt,
  holdCoveringGrants,
  type Classification,
  type ClassifyRequest,
  type NonclaimableCause,
} from './recovery/classifier.ts';
export {
  cancelAndClassify,
  discoverLiveWork,
  endLease,
  liveWorkLocks,
  replayRecordedTransitions,
  retireWork,
} from './recovery/lease-retirement.ts';
export {
  classifyAuthorityLoss,
  type AuthorityLoss,
  type RevocationWrite,
} from './recovery/authority-loss.ts';
