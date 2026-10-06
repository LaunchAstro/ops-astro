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
// that need no lease: not a lease's own work (a claim) and not a person-only
// row (`CREDENTIAL_REACH`: the task reads and writes an agent makes, comment
// changes, `run.child_handback`). Among them `task.create`, under the ticked
// `task:write`, and `session.capabilities`, whose answer is the ticked keys the
// person's grants still cover (`readCapabilities` asks within them) and the
// agent actor as the acting identity. A shared person handler holds the agent's
// limits itself (`updateTask`, `assignTask`, `commentOnTask`, #420). `run.revise_state` is excluded by name (`OUTSIDE_REACH`).
// Anything else is refused `DELEGATION_EXCLUDES_OPERATION`, recorded against
// the agent.

import { createHash } from 'node:crypto';
import {
  isAgentCredentialLive,
  NO_ASSURANCE,
  recordCredentialRefusal,
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
import { credentialNotLive } from './credential-not-live.ts';
import type { UncheckedRequest } from './requests.ts';

/** Rows the rule below would admit that a credential still never reaches. */
const OUTSIDE_REACH: ReadonlySet<CommandName> = new Set<CommandName>([
  // A run's state is revised only inside a run's delegation; refused until proved (ORCH60).
  'run.revise_state',
]);

/** The rows an agent credential's call may reach. */
export const CREDENTIAL_REACH: ReadonlySet<CommandName> = new Set(
  COMMAND_SURFACE.filter(
    (row) =>
      row.agent === 'delegated' &&
      row.authorisedOn !== 'claim' &&
      !profileOf(row).personOnly &&
      !OUTSIDE_REACH.has(row.name),
  ).map((row) => row.name),
);

/** The three levels a call counts against. */
export interface QuotaKeys {
  readonly credentialId: string;
  readonly personId: string;
  readonly businessId: string;
}

/** A call's place in the quota. */
export interface QuotaSlot {
  /**
   * Count the records `answer` hands out, at the moment it is decided: false,
   * with nothing counted, when that would take a level past its limit. Asked
   * again (a retried transaction), it first gives back what it counted before.
   */
  handOut(answer: object): boolean;
  /** Give the place back, and what was counted too when the answer never reached the caller. */
  leave(delivered: boolean): void;
}

/** The app's limits (`apps/api/auth/agent-quota.ts`): a slot, or undefined when one is reached. */
export interface CredentialQuota {
  enter(keys: QuotaKeys): QuotaSlot | undefined;
  /**
   * A place at the business's door, taken at once before the bearer is
   * resolved, or undefined when the door is full. A bearer turned away as not
   * live keeps it; any other answer gives it back. A key nobody holds has a
   * door of its own (`atUnheldKey`).
   */
  knock(door: string): DoorPlace | undefined;
}

/** A place held at a business's door. */
export interface DoorPlace {
  release(): void;
}

export interface CredentialCall {
  readonly credential: string;
  /** The time expiry is read against. */
  readonly now: Date;
  readonly quota?: CredentialQuota;
}

const OUTSIDE_FIXES: readonly string[] = [
  'An agent credential reads, adds and comments on tasks, proposes changes and asks what it may do, within the keys it was issued for.',
  'Every other operation belongs to a person.',
];

const LIMITED_FIXES: readonly string[] = [
  'This agent credential, its person or its business has made too many calls, or too many at once.',
  'Wait a minute and try again.',
];

const limited = (): CommandRefusal => refuseCommand('AGENT_QUOTA_EXCEEDED', [], LIMITED_FIXES);

/**
 * A credential at a business key nobody holds. It takes a place at that key's
 * own door and keeps it, as a bearer not live at a business does, so past the
 * door's count it is limited there too: its answers do not tell a key that
 * exists from one that does not (response time aside: catalogue #784).
 */
export function atUnheldKey(businessKey: string, quota?: CredentialQuota): CommandRefusal {
  // The caller chose the key, so the door holds its digest, never the key, and
  // is prefixed so that no key's door is a business's (whose door is its id).
  const door = `unheld:${createHash('sha256').update(businessKey).digest('hex')}`;
  if (quota !== undefined && quota.knock(door) === undefined) return limited();
  return credentialNotLive();
}

export async function executeCredentialCommand(
  database: Database,
  businessId: BusinessId,
  call: CredentialCall,
  request: UncheckedRequest,
): Promise<CommandResult | ReadResult> {
  // Taken before the bearer is resolved, so a cold burst cannot all see room.
  const place = call.quota?.knock(businessId);
  const doorFull = call.quota !== undefined && place === undefined;
  // Past a full door, one unlocked read before the call's transaction: a bearer
  // not live is limited with nothing held and nothing written, and a live one,
  // never known before or made live again, goes on as below the door.
  if (doorFull && !(await database.withBusiness(businessId, (tx) => live(tx, call)))) {
    return asCallerVisible(limited());
  }
  let kept = false;
  try {
    const answer = await resolvedAndRun(database, businessId, call, request, doorFull);
    kept = isCommandRefusal(answer) && answer.code === 'DELEGATION_NOT_LIVE';
    return answer;
  } finally {
    if (!kept) place?.release();
  }
}

async function resolvedAndRun(
  database: Database,
  businessId: BusinessId,
  call: CredentialCall,
  request: UncheckedRequest,
  doorFull: boolean,
): Promise<CommandResult | ReadResult> {
  // Entered once per request, outside `retryOnce`, so a retry is not a second call.
  const held: Held = {};
  let answer: CommandResult | ReadResult;
  try {
    answer = await retryOnce(
      async () =>
        await database.withBusiness(
          businessId,
          async (tx) => await attempt(tx, call, request, doorFull, held),
        ),
    );
  } catch (cause) {
    if (!(cause instanceof ExportLimitReached)) {
      held.slot?.leave(false);
      throw cause;
    }
    answer = limited();
  }
  held.slot?.leave(!isCommandRefusal(answer));
  if (!isCommandRefusal(answer)) return answer;
  return asCallerVisible(answer);
}

/** The call's place in the quota, once it is let in. */
interface Held {
  slot?: QuotaSlot | undefined;
}

/** One try of the call, inside its transaction. */
async function attempt(
  tx: TenantQuery,
  call: CredentialCall,
  request: UncheckedRequest,
  doorFull: boolean,
  held: Held,
): Promise<CommandResult | ReadResult> {
  const standing = await resolveAgentCredential(tx, call.credential, call.now);
  if (standing === 'not-live') return await notLive(tx, call.credential, doorFull);
  const keys = {
    credentialId: standing.credentialId,
    personId: standing.personId,
    businessId: tx.businessId,
  };
  // Before the reach, so a call outside it counts too.
  held.slot ??= call.quota?.enter(keys);
  if (call.quota !== undefined && held.slot === undefined) {
    return limited();
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
  const ran =
    declarationOf(request.command).kind === 'read'
      ? await runRead(tx, session, readOf(request))
      : await runCommand(tx, session, 'api', request);
  // Counted here, before the commit: calls let in at once all saw room at the
  // door, and the one that would pass the limit rolls back.
  if (held.slot !== undefined && !isCommandRefusal(ran) && !held.slot.handOut(ran)) {
    throw new ExportLimitReached();
  }
  return ran;
}

/** Thrown inside the transaction so an answer over the export limit applies nothing. */
class ExportLimitReached extends Error {}

const live = async (tx: TenantQuery, call: CredentialCall): Promise<boolean> =>
  await isAgentCredentialLive(tx, call.credential, call.now);

/**
 * A credential turned away is an attempt at the door (I13), answered as every
 * other. Past the door's count it is answered as limited and writes no row,
 * while a live bearer is still served.
 */
async function notLive(
  tx: TenantQuery,
  credential: string,
  doorFull: boolean,
): Promise<CommandRefusal> {
  if (doorFull) return limited();
  const refusal = credentialNotLive();
  await recordCredentialRefusal(tx, credential, refusal.code);
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
