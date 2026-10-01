// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent credential's calls (API-2): a person's standing delegation to an
// agent actor of theirs, presented as the bearer on the agent prefix.
//
// **Resolved on every call, under the row's lock.** The secret is looked up
// by its digest in the business the path names (`resolveAgentCredential`),
// and it is served only while it is not revoked, not past its expiry, its
// agent actor is active and its issuer is still a member. Every other answer
// is `DELEGATION_NOT_LIVE` in the same words, so a caller holding a stolen or
// made-up secret learns nothing about which it is.
//
// **What it runs as.** A session whose actor is the credential's agent and
// whose person is the one it acts for, with the ticked keys beside it. The
// command and read envelopes are the person's own, unchanged: the audit
// event, the register row and any record the call writes carry the agent
// actor, and `agent_credentials` names the person that actor acts for. Every
// grant check asks the key within the ticked ones as well as the person's
// grants as they are now (`subjectsOf`), and the credential has no sign-in
// assurance, so no money step-up is ever met.
//
// **What it reaches.** The surface rows an agent may reach under a delegation
// that need no lease: not a lease's own work (a claim), not a person-only row
// and not `session.capabilities`, whose answer would be the person's keys
// rather than the credential's. Anything else is refused
// `DELEGATION_EXCLUDES_OPERATION`, recorded against the agent.

import {
  NO_ASSURANCE,
  digestOf,
  recordAuthenticationAttempt,
  resolveAgentCredential,
} from '../../../core-records/src/index.ts';
import type {
  BusinessId,
  CredentialStanding,
  Database,
  Session,
  TenantQuery,
} from '../../../core-records/src/index.ts';
import { COMMAND_SURFACE, declarationOf, profileOf } from '../../../core-wire/src/index.ts';
import type { CommandName } from '../../../core-wire/src/index.ts';
import { runRead } from '../reads/dispatch.ts';
import type { ReadRequest, ReadResult } from '../reads/requests.ts';
import { enter, retryOnce, runCommand } from './envelope.ts';
import {
  asCallerVisible,
  isCommandRefusal,
  refuseCommand,
  type CommandRefusal,
} from './refusal.ts';
import type { CommandResult } from './register-store.ts';
import type { UncheckedRequest } from './requests.ts';

/** The rows an agent credential's call may reach. */
export const CREDENTIAL_REACH: ReadonlySet<CommandName> = new Set(
  COMMAND_SURFACE.filter(
    (row) =>
      row.agent === 'delegated' &&
      row.authorisedOn !== 'claim' &&
      !profileOf(row).personOnly &&
      row.name !== 'session.capabilities',
  ).map((row) => row.name),
);

/** The three levels a call counts against. */
export interface QuotaKeys {
  readonly credentialId: string;
  readonly personId: string;
  readonly businessId: string;
}

/** A call's place in the quota, given back with what it handed out. */
export interface QuotaSlot {
  leave(answer: object | undefined): void;
}

/** The app's limits (`apps/api/auth/agent-quota.ts`): a slot, or undefined when one is reached. */
export interface CredentialQuota {
  enter(keys: QuotaKeys): QuotaSlot | undefined;
}

export interface CredentialCall {
  readonly credential: string;
  /** The time expiry is read against. */
  readonly now: Date;
  readonly quota?: CredentialQuota;
}

const NOT_LIVE_FIXES: readonly string[] = [
  'This agent credential is not live: it was revoked, it has expired, or it was never issued here.',
  'Ask the person it acts for to issue a new one on Settings ▸ Access.',
];

const OUTSIDE_FIXES: readonly string[] = [
  'An agent credential reads and comments on tasks and proposes changes, within the keys it was issued for.',
  'Every other operation belongs to a person.',
];

const LIMITED_FIXES: readonly string[] = [
  'This agent credential, its person or its business has made too many calls, or too many at once.',
  'Wait a minute and try again.',
];

/** The one answer for a credential not served: unknown, revoked, expired, or a key nobody holds. */
export const credentialNotLive = (): CommandRefusal =>
  refuseCommand('DELEGATION_NOT_LIVE', [], NOT_LIVE_FIXES);

export async function executeCredentialCommand(
  database: Database,
  businessId: BusinessId,
  call: CredentialCall,
  request: UncheckedRequest,
): Promise<CommandResult | ReadResult> {
  // Entered once per request, outside `retryOnce`, so a retry is not a second call.
  let slot: QuotaSlot | undefined;
  let answer: CommandResult | ReadResult | undefined;
  try {
    answer = await retryOnce(
      async () =>
        await database.withBusiness(businessId, async (tx) => {
          const standing = await resolveAgentCredential(tx, call.credential, call.now);
          if (standing === 'not-live') return await refusedAtTheDoor(tx, call.credential);
          const keys = {
            credentialId: standing.credentialId,
            personId: standing.personId,
            businessId,
          };
          // Before the reach, so a call outside it counts too.
          slot ??= call.quota?.enter(keys);
          if (call.quota !== undefined && slot === undefined) {
            return refuseCommand('AGENT_QUOTA_EXCEEDED', [], LIMITED_FIXES);
          }
          const session = sessionOf(standing, tx.businessId);
          if (!CREDENTIAL_REACH.has(request.command)) {
            const outside = refuseCommand(
              'DELEGATION_EXCLUDES_OPERATION',
              [request.command],
              OUTSIDE_FIXES,
            );
            return await enter(tx, session, request, { outside });
          }
          return declarationOf(request.command).kind === 'read'
            ? await runRead(tx, session, readOf(request))
            : await runCommand(tx, session, 'api', request);
        }),
    );
    return isCommandRefusal(answer) ? asCallerVisible(answer) : answer;
  } finally {
    slot?.leave(answer === undefined || isCommandRefusal(answer) ? undefined : answer);
  }
}

/**
 * A credential turned away is an attempt at the door (I13): recorded against
 * the digest of its digest, never the secret, and answered as every other.
 */
async function refusedAtTheDoor(tx: TenantQuery, credential: string): Promise<CommandRefusal> {
  const refusal = credentialNotLive();
  const presented = {
    provider: 'agent-credential',
    subject: digestOf(credential),
    assurance: NO_ASSURANCE,
  };
  await recordAuthenticationAttempt(tx, {
    owner: 'delegation',
    presented,
    outcome: 'refused',
    refusalCode: refusal.code,
  });
  return refusal;
}

/** The agent actor, acting for its person within the ticked keys, with no sign-in assurance. */
function sessionOf(standing: CredentialStanding, businessId: string): Session {
  return {
    businessId,
    // No login stands behind a credential; its own id is the one it signs in as.
    loginId: standing.credentialId,
    personId: standing.personId,
    actorId: standing.agentActorId,
    roleKey: standing.roleKey,
    assurance: NO_ASSURANCE,
    credentialScope: standing.scope,
  };
}

/** The read the route names, from the body the route took; the name is never the body's. */
function readOf(request: UncheckedRequest): ReadRequest {
  const { command, ...body } = request;
  return { ...body, read: command } as ReadRequest;
}
