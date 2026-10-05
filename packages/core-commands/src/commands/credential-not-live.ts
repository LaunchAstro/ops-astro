// SPDX-License-Identifier: AGPL-3.0-only
//
// The one answer for an API-2 agent credential not served, whichever the
// reason: the credential envelope's at the door, and a step result's when the
// credential lapsed while it waited on a lock (`onboarding-authority.ts`).

import { refuseCommand, type CommandRefusal } from './refusal.ts';

const NOT_LIVE_FIXES: readonly string[] = [
  'This agent credential is not live: it was revoked, it has expired, or it was never issued here.',
  'Ask the person it acts for to issue a new one on Settings ▸ Access.',
];

/** The one answer for a credential not served: unknown, revoked, expired, or a key nobody holds. */
export const credentialNotLive = (): CommandRefusal =>
  refuseCommand('DELEGATION_NOT_LIVE', [], NOT_LIVE_FIXES);
