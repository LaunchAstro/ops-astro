// SPDX-License-Identifier: AGPL-3.0-only
//
// C58 (CS-2.25): end a person's access in one act, the tracked action
// `access ended (person: login, sessions, grants)` under `access:manage`,
// never an agent's.
//
// The act is local first. One transaction, under the business's access lock:
// the person's membership and acting identity end, every live grant they hold
// and every delegation they gave are revoked (`endPersonAuthority`), every
// agent credential they issued here is revoked with its agent actor, and one
// access ending is written per login mapped to them, owing the provider two
// steps. From that commit login resolution refuses the person
// (`AUTH_NO_MEMBERSHIP`), whatever the provider has or has not done
// (TR-SEC5-4).
//
// The provider steps are never taken inside the act's transaction. They are
// tried as soon as the act commits and retried by the endings loop until each
// is done (`settleAccessEndings`): end every session, which revokes their
// refresh tokens, then deactivate the login. A step done is stamped once and
// never asked again. An answer the adapter does not accept, a throw or a
// timeout is a fault by its kind alone, and the step stays owed.

import {
  factorLoginLiveElsewhere,
  isUuid,
  lastManager,
  lockAccess,
  lockAgentCredential,
  otherManagers,
  revokeAgentCredential,
} from '../../../core-records/src/index.ts';
import type { BusinessId, Database, TenantQuery } from '../../../core-records/src/index.ts';
import { claimNextEnding, endingsOwed, lockEnding, type OwedEnding } from './access-end-claim.ts';
import type { ProviderAnswer, ProviderFault } from './account-factor-provider.ts';
import { endPersonAuthority } from './authority-controls.ts';
import type { CommandContext } from './context.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand } from './refusal.ts';
import type { CommandRequest } from './requests.ts';

/**
 * The sign-in provider's two calls for a login whose access has ended: end
 * every session it has (which revokes their refresh tokens), and deactivate
 * the login so it cannot sign in again. Each is keyed by the provider's own
 * subject and is safe to ask twice.
 */
export interface LoginProvider {
  endSessions(subject: string): Promise<ProviderAnswer<void>>;
  deactivate(subject: string): Promise<ProviderAnswer<void>>;
  /**
   * C59 (ORCH65-Q3): remove one factor of the login, an owner's reset of a
   * lost authenticator (`factor-reset.ts`). Absent where no admin key is
   * held: then nothing is sent and the step stays owed.
   */
  deleteFactor?(subject: string, factorId: string): Promise<ProviderAnswer<void>>;
}

/**
 * What one pass over a business's owed endings (or C59's resets) did, by
 * count only: `owed` is every one still owing a step after it, one another
 * retry holds included, and `faults` the ones this pass asked that ended on a
 * fault.
 */
export interface SettleReport {
  readonly attempted: number;
  readonly settled: number;
  readonly owed: number;
  readonly faults: number;
}

/**
 * How long a retry's claim on one ending lasts. Each ending is claimed just
 * before its own calls, and this is longer than the wait for the login's lock
 * and both calls can take, so a second retry never calls the provider for an
 * ending the first is still working on.
 */
export const ACCESS_ENDING_CLAIM_SECONDS = 30;

const HOLDER_FIXES: readonly string[] = ['Name the person whose access ends by their identifier.'];
const NOT_MEMBER_FIXES: readonly string[] = [
  'No person of this business with an active membership carries that identifier.',
  'Read access.read for who is here.',
];

export async function endAccessOnSettings(
  tx: TenantQuery,
  context: CommandContext,
  request: CommandRequest & { readonly command: 'access.end' },
): Promise<HandlerOutcome> {
  const { holderId } = request;
  if (typeof holderId !== 'string' || !isUuid(holderId)) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['holderId'], HOLDER_FIXES));
  }
  const personId = holderId.toLowerCase();
  // The access lock first, as every change to who may do what takes it; then
  // the membership row, so two endings of one person serialise here.
  await lockAccess(tx);
  const member = await tx.query<{ readonly id: string }>(
    `select id from public.memberships
      where business_id = $1 and person_id = $2::uuid and active
      for update`,
    [tx.businessId, personId],
  );
  if (member.length === 0) {
    return refused(refuseCommand('NOT_FOUND', ['holderId'], NOT_MEMBER_FIXES));
  }
  if ((await otherManagers(tx, [], personId)) === 0) return refused(lastManager());

  const authority = await endPersonAuthority(tx, personId, context.session.actorId);
  const credentialsRevoked = await revokeIssued(tx, personId, context.session.actorId);
  const endings = await endStanding(tx, personId, context.session.actorId);
  return applied(personId, null, {
    personId,
    grantsRevoked: authority.grantsRevoked,
    delegationsRevoked: authority.delegationsRevoked,
    credentialsRevoked,
    classifiedHolds: authority.classifiedHolds,
    endingIds: endings.map((row) => row.id),
  });
}

/**
 * Every agent credential the person issued in this business and has not been
 * revoked, revoked by the one ending their access, each agent actor with it
 * (`revokeAgentCredential`), so nothing they issued outlives the ending.
 */
async function revokeIssued(tx: TenantQuery, personId: string, endedBy: string): Promise<number> {
  const issued = await tx.query<{ readonly id: string }>(
    `select id from public.agent_credentials
      where business_id = $1 and issued_by_person_id = $2::uuid and revoked_at is null
      order by id
      for update`,
    [tx.businessId, personId],
  );
  for (const { id } of issued) {
    // eslint-disable-next-line no-await-in-loop -- one credential at a time, each already locked
    const held = await lockAgentCredential(tx, id);
    // eslint-disable-next-line no-await-in-loop -- its revocation, under that lock
    if (held !== undefined) await revokeAgentCredential(tx, held, endedBy);
  }
  return issued.length;
}

/**
 * The person's membership and acting identity end, and one access ending per
 * login mapped to them is written, owing the provider its two steps.
 */
async function endStanding(
  tx: TenantQuery,
  personId: string,
  endedBy: string,
): Promise<readonly { readonly id: string }[]> {
  await tx.query(
    `update public.memberships set active = false, ended_at = now()
      where business_id = $1 and person_id = $2::uuid and active`,
    [tx.businessId, personId],
  );
  await tx.query(
    `update public.actors set active = false, deactivated_at = now()
      where business_id = $1 and person_id = $2::uuid and kind = 'person' and active`,
    [tx.businessId, personId],
  );
  return await tx.query<{ readonly id: string }>(
    `insert into public.access_endings (business_id, person_id, login_id, ended_by_actor_id)
     select pl.business_id, pl.person_id, pl.login_id, $3::uuid
       from public.person_logins pl
      where pl.business_id = $1 and pl.person_id = $2::uuid and pl.active
     returning id`,
    [tx.businessId, personId, endedBy],
  );
}

/**
 * One pass over this business's endings with a provider step owed, claimed
 * one row at a time (`claimNextEnding`) just before its calls, so a pass of
 * slow calls never lets a claim lapse on a row still waiting its turn.
 *
 * Each claimed ending is worked in one transaction that takes the login's
 * subject lock first and reads its stamps again (`lockEnding`), and writes
 * nothing until its calls are done: the shared-login check, asked again under
 * the lock, then the provider, sessions before the login (a provider may
 * refuse to sign out a login it has already deactivated), stopping at the
 * first fault, then the stamp. A login another business maps under that lock is either seen by the
 * check or waits for the stamp. `coalesce` keeps a step's first stamp, so a
 * step done is never undone or re-dated.
 */
export async function settleAccessEndings(
  database: Database,
  businessId: BusinessId,
  provider: LoginProvider,
  options: {
    /**
     * Whether the subject is still live in another business (ORCH46 ruling A):
     * then the ban would end that business's access too, so both steps are
     * stamped done with the reason `shared` and nothing is sent.
     */
    readonly sharedElsewhere: (subject: string) => Promise<boolean>;
    readonly claimSeconds?: number;
    readonly lockWaitMs?: number;
    /** Only these endings: the ones an act has just written. All owed ones otherwise. */
    readonly only?: readonly string[];
  },
): Promise<SettleReport> {
  const claimSeconds = options.claimSeconds ?? ACCESS_ENDING_CLAIM_SECONDS;
  const only = options.only ?? null;
  const tried: string[] = [];
  let settled = 0;
  let faults = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- one ending at a time, each claimed before its calls
    const row = await claimNextEnding(database, businessId, claimSeconds, only, tried);
    if (row === undefined) break;
    tried.push(row.id);
    let done: Attempted;
    try {
      // eslint-disable-next-line no-await-in-loop -- its calls and stamp, before the next is claimed
      done = await database.withBusiness(businessId, async (tx) => {
        const now = await lockEnding(tx, row, options.lockWaitMs);
        const answer = await attempt(tx, provider, now, options.sharedElsewhere);
        await stamp(tx, row.id, answer);
        return answer;
      });
    } catch (cause) {
      // A lock not taken in time rolls back unstamped: the ending stays owed.
      if ((cause as { readonly code?: unknown }).code === '55P03') continue;
      throw cause;
    }
    if (done.sessions && done.login) settled += 1;
    if (done.fault !== null) faults += 1;
  }
  const owed = await endingsOwed(database, businessId, only);
  return { attempted: tried.length, settled, owed, faults };
}

/** What was done, stamped once: `coalesce` keeps each step's first stamp. */
async function stamp(tx: TenantQuery, id: string, done: Attempted): Promise<void> {
  await tx.query(
    `update public.access_endings
        set sessions_ended_at = case when $3 then coalesce(sessions_ended_at, now())
                                     else sessions_ended_at end,
            login_deactivated_at = case when $4 then coalesce(login_deactivated_at, now())
                                        else login_deactivated_at end,
            last_fault = $5,
            provider_steps_skipped = coalesce(provider_steps_skipped, $6)
      where business_id = $1 and id = $2`,
    [tx.businessId, id, done.sessions, done.login, done.fault, done.skipped],
  );
}

interface Attempted {
  sessions: boolean;
  login: boolean;
  fault: ProviderFault | null;
  skipped: 'shared' | null;
}

async function attempt(
  tx: TenantQuery,
  provider: LoginProvider,
  row: OwedEnding,
  sharedElsewhere: (subject: string) => Promise<boolean>,
): Promise<Attempted> {
  let sessions = row.sessions_done;
  let login = row.login_done;
  // Both stamped by another retry while this one waited: nothing is asked.
  if (sessions && login) return { sessions, login, fault: null, skipped: null };
  // Asked before any call; a failure to ask is a fault, and the steps stay owed.
  let shared: boolean;
  try {
    shared = await sharedElsewhere(row.subject);
  } catch {
    return { sessions, login, fault: 'unreachable', skipped: null };
  }
  // Asked again under the subject lock, so a login mapped after the first
  // answer is seen. An answer of doubt is a yes: nothing is sent.
  shared ||= await factorLoginLiveElsewhere(tx, row.login_id);
  if (shared) return { sessions: true, login: true, fault: null, skipped: 'shared' };
  if (!sessions) {
    const answer = await asked(async () => await provider.endSessions(row.subject));
    if (!answer.ok) return { sessions, login, fault: answer.fault, skipped: null };
    sessions = true;
  }
  if (!login) {
    const answer = await asked(async () => await provider.deactivate(row.subject));
    if (!answer.ok) return { sessions, login, fault: answer.fault, skipped: null };
    login = true;
  }
  return { sessions, login, fault: null, skipped: null };
}

/** A provider call that throws is a fault by its kind, never its words. */
async function asked(call: () => Promise<ProviderAnswer<void>>): Promise<ProviderAnswer<void>> {
  try {
    return await call();
  } catch {
    return { ok: false, fault: 'unreachable' };
  }
}
