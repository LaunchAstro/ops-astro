// SPDX-License-Identifier: AGPL-3.0-only
//
// Identity's sign-in records: agent and person logins, attempts, standing,
// assurance, second factors and seen sessions. The other packages reach them
// through the package index, which re-exports this file whole.

export {
  EXPIRED_FIXES,
  NO_AGENT_FIXES,
  resolveAgentLogin,
  type AgentSession,
} from './agent-login.ts';
export { recordAuthenticationAttempt, recordBodyRefusal } from './authentication-attempts.ts';
export {
  NO_MEMBERSHIP_FIXES,
  standsOnShares,
  standingOf,
  resolveLogin,
  withSession,
  type SecondFactorRule,
  type Session,
  type VerifiedSubject,
} from './login-resolution.ts';
export { withStanding } from './standing.ts';
export {
  NO_ASSURANCE,
  SESSION_ABSOLUTE_SECONDS,
  SIGN_IN_CLOCK_SKEW_SECONDS,
  type Assurance,
  type AssuranceLevel,
} from './verified-subject.ts';
export {
  liveFactor,
  lockLoginFactors,
  loginHasVerifiedFactor,
  recordFactorEnrolled,
  recordFactorRemoved,
  recordFactorVerified,
  type FactorStatus,
  type SecondFactor,
} from './second-factor.ts';
export {
  endOtherSeenSessions,
  endSeenSessions,
  endProviderSession,
  endOwnSession,
  listSeenSessions,
  openResetWindow,
  sessionEnded,
  settleResetWindow,
  waitForNextSecond,
  type SeenSession,
  type SessionEndReason,
} from './sessions.ts';
