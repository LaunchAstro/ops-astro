// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent credential's quota (API-2): requests a minute, calls in flight
// and records handed out a minute, each held per credential, per person and
// per business.

/** One limit at each of the three levels a credential's call counts against. */
export interface Tiers {
  readonly credential: number;
  readonly person: number;
  readonly business: number;
}

export interface AgentLimits {
  /** Calls a minute. */
  readonly requests: Tiers;
  /** Calls at once. */
  readonly concurrent: Tiers;
  /** Records handed out a minute. */
  readonly exports: Tiers;
}
