// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's own login, which is not a person's.
//
// `login-resolution.ts` resolves `a.kind = 'person'` and says so. That is the
// honest half, and it is only half: the contract keeps a person's login, an
// agent login and a delegation credential distinct (transaction contract,
// delegation), and an agent that signs in with a person's credential is the
// collapse 0002 exists to prevent, arriving one layer up.
//
// So this resolves the other mapping table. A login is in `person_logins` or
// in `actor_logins`, never both — two triggers in 0008 hold that — and the
// session this returns carries no `personId` at all. Not null: absent. A field
// that is sometimes a person is a field some later `??` will fill in.
//
// The agent session confers nothing on its own. What the agent may do comes
// from a delegation resolved against it (`authority/delegations.ts`), which is
// why there is no grant lookup here.

import type { TenantQuery } from '../tenancy/database.ts';
import { refuseAgent, type AgentRefusal } from './refusals.ts';
import type { VerifiedSubject } from './verified-subject.ts';
import { recordAuthenticationAttempt } from './authentication-attempts.ts';

/** What an authenticated agent call runs as. There is no person here. */
export interface AgentSession {
  readonly businessId: string;
  readonly loginId: string;
  readonly actorId: string;
  readonly kind: 'agent';
}

interface AgentRow {
  readonly login_id: string;
  readonly actor_id: string | null;
}

export const NO_AGENT_FIXES = [
  'ask an administrator of this business to link this login to an agent identity',
  'a person signs in through the person login path, not this one',
] as const;

// One statement, left-joined, for the reason the person resolver gives: the
// facts are read under one snapshot and one policy evaluation. `kind = 'agent'`
// is in the join rather than a filter afterwards, so a login mapped to a person
// actor produces the same nothing an unmapped login does.
const RESOLUTION = `
  select l.id as login_id,
         a.id as actor_id
    from public.logins l
    left join public.actor_logins al
      on al.business_id = l.business_id and al.login_id = l.id and al.active
    left join public.actors a
      on a.business_id = al.business_id and a.id = al.actor_id
     and a.kind = 'agent' and a.active
   where l.provider = $1 and l.subject = $2`;

/**
 * Resolve an agent's verified subject to its acting identity.
 *
 * One refusal for every way it can fail: no login here, a login mapped to a
 * person, a mapping that was deactivated, an agent actor that was. Telling
 * them apart tells the caller what exists in a business it has not been let
 * into, which is the inference channel `AUTH_NO_MEMBERSHIP` closes on the
 * person side.
 *
 * Every attempt is recorded, resolved or refused, before this returns.
 */
export async function resolveAgentLogin(
  tx: TenantQuery,
  presented: VerifiedSubject,
): Promise<AgentSession | AgentRefusal> {
  const rows = await tx.query<AgentRow>(RESOLUTION, [presented.provider, presented.subject]);
  const found = rows[0];

  if (found === undefined || found.actor_id === null) {
    const refusal = refuseAgent('AUTH_NO_AGENT_IDENTITY', NO_AGENT_FIXES);
    await recordAuthenticationAttempt(tx, {
      owner: 'agent_login',
      presented,
      outcome: 'refused',
      refusalCode: refusal.code,
    });
    return refusal;
  }

  const session: AgentSession = {
    businessId: tx.businessId,
    loginId: found.login_id,
    actorId: found.actor_id,
    kind: 'agent',
  };
  await recordAuthenticationAttempt(tx, {
    owner: 'agent_login',
    presented,
    outcome: 'resolved',
    loginId: session.loginId,
    actorId: session.actorId,
  });
  return session;
}

/**
 * What the server answers when the presented token has expired.
 *
 * It is a typed refusal, not an empty result and not a 500, because the web
 * client has to be able to tell "your session ended, sign in again" from
 * "you may not see this" and from "the server is broken". Those are three
 * different things to show a person and only one of them is a re-login path.
 * The browser half of this is L5's; what is fixed here is the code it reads.
 */
export function refuseExpiredSession(): AgentRefusal {
  return refuseAgent('AUTH_SESSION_EXPIRED', [
    'The session has expired. Sign in again to continue.',
    'Nothing was changed by this call.',
  ]);
}
