// SPDX-License-Identifier: AGPL-3.0-only
//
// The refusal codes that end a tab's session, or that say nothing about whether
// its bearer was ever a member here: the client's rules (client.ts) read them.

/**
 * The two codes that mean the bearer is no longer a credential.
 *
 * Paired with the 401 rather than trusted alone: the code names the decision
 * and the status names the boundary that made it, and a 403 carrying either of
 * these would be a different answer than the one this rule is about.
 *
 * They are two because the API tells them apart on purpose (`AUTH_UNKNOWN_LOGIN`
 * says nothing of which guess was closer; `AUTH_SESSION_EXPIRED` goes only to a
 * bearer this deployment signed). The difference is for the reader, not this client.
 */
export const SESSION_ENDED: ReadonlySet<string> = new Set([
  'AUTH_UNKNOWN_LOGIN',
  'AUTH_SESSION_EXPIRED',
]);

/** The API's 403 for a login whose access to this business was ended (C58): matched whole. */
export const ACCESS_ENDED = 'AUTH_ACCESS_ENDED';

/** Refusals besides the 401s that can come before login resolution places a member. */
export const BEFORE_LOGIN: ReadonlySet<string> = new Set([
  'AUTH_NO_MEMBERSHIP',
  'AUTH_ACCESS_ENDED',
  'ACTOR_INACTIVE',
  'AUTH_CROSS_SITE',
  'AUTH_SESSION_MISMATCH',
  'COMMAND_BODY_INVALID',
]);
