// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P3: `invitation accepted` and `login created (person,
// business)` for a person who already holds a login (another business's, or
// one made elsewhere) and is signed in with it. The one-time token is still
// the authority over the invitation; the verified session says which login
// is bound. No password is asked and none is set.
//
// 1. Find the token, exactly as the token-only accept does (`find`): every
//    business, each under its own tenancy, one answer for every token that
//    is not live, `ENROLMENT_LINK_INVALID`. Nothing is asked of the provider
//    for a dead token.
// 2. Read the session's login at the login provider, through custody
//    (`auth.read_user`). The token's own claims carry no authority
//    (`apps/api/auth/supabase.ts`), so the address is the provider's, and
//    only an address the provider confirmed counts. It must be the
//    invitation's. A login the provider does not hold, an address it has
//    not confirmed and another address all answer as a dead link does, and
//    spend nothing: telling them apart would tell the holder of a link
//    which logins exist. A provider fault is `ENROLMENT_UNAVAILABLE`.
// 3. In one transaction, under the login id locks (`lockLogin`, the token-only
//    accept's own) of the invitation's login id for the address and of the
//    session's login, sorted, then the invitation's lock,
//    and every check of the token again: a login this business has mapped
//    to anyone (a person or an agent) is refused as a dead link; otherwise
//    the token-only accept's own writes (`spendAndSeat`) spend every token,
//    accept, seat the invitation's person, map this login to them (its
//    `logins` row made here when this business has none) and audit both
//    acts as the business's worker. The answer opens no session: the person
//    goes on with the session they have.

import { createHash } from 'node:crypto';
import {
  type Database,
  type TenantQuery,
  type VerifiedSubject,
} from '../../../core-records/src/index.ts';
import { readLogin, type Broker } from '../../../core-custody/src/index.ts';
import {
  find,
  liveToken,
  lockLogin,
  LOGIN_PROVIDER,
  loginSubject,
  spendAndSeat,
  TOKEN,
} from './invitation-accept.ts';

export interface SignedInAcceptRequest {
  readonly token: string;
  /** The verified session's login: the provider and its subject, nothing the caller wrote. */
  readonly login: VerifiedSubject;
}

export type SignedInAcceptResult =
  | { readonly ok: true; readonly state: 'joined' }
  | { readonly ok: false; readonly code: 'ENROLMENT_LINK_INVALID' | 'ENROLMENT_UNAVAILABLE' };

const INVALID = { ok: false, code: 'ENROLMENT_LINK_INVALID' } as const;

/** Whether this business maps the login to anyone now: a person or an agent. */
async function mappedHere(tx: TenantQuery, subject: string): Promise<boolean> {
  const rows = await tx.query(
    `select 1 from logins l
      where l.business_id = $1 and l.provider = $2 and l.subject = $3
        and (exists (select 1 from person_logins pl
                      where pl.business_id = l.business_id and pl.login_id = l.id and pl.active)
          or exists (select 1 from actor_logins al
                      where al.business_id = l.business_id and al.login_id = l.id and al.active))`,
    [tx.businessId, LOGIN_PROVIDER, subject],
  );
  return rows.length > 0;
}

/** Step 3: false when the token died, or this business maps the login already. */
async function bindSignedIn(
  tx: TenantQuery,
  hash: string,
  ours: string,
  subject: string,
): Promise<boolean> {
  // Sorted, so two accepts that take both locks take them in one order.
  for (const key of [...new Set([ours, subject])].toSorted()) {
    // oxlint-disable-next-line no-await-in-loop -- one lock after the other, in order
    await lockLogin(tx, key);
  }
  const found = await liveToken(tx, hash, true);
  if (found === undefined || (await mappedHere(tx, subject))) return false;
  await spendAndSeat(tx, found, subject);
  return true;
}

/** Accept the invitation a one-time token names, binding the signed-in session's login to it. */
export async function acceptSignedIn(
  database: Database,
  businesses: readonly string[],
  broker: Broker,
  request: SignedInAcceptRequest,
): Promise<SignedInAcceptResult> {
  const hash = createHash('sha256').update(request.token).digest('hex');
  const found = TOKEN.test(request.token) ? await find(database, businesses, hash) : undefined;
  if (found === undefined || request.login.provider !== LOGIN_PROVIDER) return INVALID;
  const { subject } = request.login;
  const read = await readLogin(broker, subject);
  if (!read.ok)
    return read.kind === 'refused' ? INVALID : { ok: false, code: 'ENROLMENT_UNAVAILABLE' };
  if (read.confirmed !== found.address) return INVALID;
  const ours = loginSubject(found.business, found.address);
  const bound = await database.withBusiness(
    found.business,
    async (tx) => await bindSignedIn(tx, hash, ours, subject),
  );
  return bound ? { ok: true, state: 'joined' } : INVALID;
}
