// SPDX-License-Identifier: AGPL-3.0-only
//
// C59 (ORCH65-Q3): the owner resets a member's lost authenticator, the
// tracked action `second factor reset (person, by)` under `settings:manage`,
// never an agent's.
//
// The provider refuses a new enrolment, and the removal of a verified factor,
// below `aal2`, so a member who has lost theirs cannot clear it alone. The act
// asks the caller's own fresh step-up whatever the money setting, and refuses
// the caller's own person (their own removal is theirs, with a code). Then, in
// one transaction under the business's access lock: the member's live factor
// is recorded removed (here and by subject, 0064), every session of theirs is
// ended (0057, 0063), and one reset row owes the provider its admin removal of
// that factor (20261003003537). The removal is never sent inside the transaction: the
// local server tries it once the act commits, and the endings loop retries it
// (`settleFactorResets`).
//
// The provider holds one set of factors per sign-in login, so clearing one
// clears it in every business that login reaches. While the login is live in
// another business the reset is refused, in the same words as every other
// refusal of this code, which never say where else the login is. So is a
// reset upward: the caller must hold every business-wide grant the member
// holds (ORCH66-FACTORM2), so one owner may reset another, never a lesser
// holder of `settings:manage` the owner.

import {
  endOtherSeenSessions,
  factorLoginLiveElsewhere,
  heldPermissions,
  isUuid,
  judgeStepUp,
  liveFactor,
  lockAccess,
  recordFactorRemoved,
} from '../../../core-records/src/index.ts';
import type { SecondFactor, TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { applied, refused, type HandlerOutcome, type Refused } from './outcome.ts';
import { refuseCommand } from './refusal.ts';
import type { CommandRequest } from './requests.ts';

const HOLDER_FIXES: readonly string[] = [
  'Name the person whose authenticator is reset by their identifier.',
];
const NOT_MEMBER_FIXES: readonly string[] = [
  'No person of this business with an active membership carries that identifier.',
  'Read access.read for who is here.',
];
/** `step-up.ts`'s own first fix, then this act's window in its words. */
const STEP_UP_FIXES: readonly string[] = [
  'Sign in again with the code from your authenticator app, then retry.',
  "Resetting another person's authenticator needs a sign-in with the second factor in the last 60 minutes.",
];
const NOT_ENROLLED_FIXES: readonly string[] = [
  'This person has no authenticator app set up here, so there is nothing to reset.',
];
/** One set of words for every reason this code is given. */
const REFUSED_FIXES: readonly string[] = [
  "This person's authenticator cannot be reset here.",
  'They can remove or replace it themselves from their own account settings.',
];

const resetRefused = () => refused(refuseCommand('FACTOR_RESET_REFUSED', [], REFUSED_FIXES));

export async function resetFactorOnSettings(
  tx: TenantQuery,
  context: CommandContext,
  request: CommandRequest & { readonly command: 'access.reset_factor' },
): Promise<HandlerOutcome> {
  const { holderId } = request;
  if (typeof holderId !== 'string' || !isUuid(holderId)) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['holderId'], HOLDER_FIXES));
  }
  if (!(await steppedUp(tx, context))) {
    return refused(refuseCommand('STEP_UP_REQUIRED', [], STEP_UP_FIXES));
  }
  const personId = holderId.toLowerCase();
  if (personId === context.session.personId) return resetRefused();

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
  if (await outranks(tx, personId, context.session.personId)) return resetRefused();
  const held = await heldFactor(tx, personId);
  if ('refusal' in held) return held;
  const { login, factor } = held;

  await recordFactorRemoved(tx, { personId, factorId: factor.id, subject: login.subject });
  await endOtherSeenSessions(tx, personId, undefined, 'factor_change', login.subject);
  const written = await tx.query<{ readonly id: string }>(
    `insert into public.factor_resets
       (business_id, person_id, login_id, reset_by_actor_id, provider_factor_id)
     values ($1, $2::uuid, $3::uuid, $4::uuid, $5)
     returning id`,
    [tx.businessId, personId, login.id, context.session.actorId, factor.providerFactorId],
  );
  return applied(personId, null, { resetId: written[0]?.id, providerStep: 'owed' });
}

/**
 * The caller's own step-up, against the database's clock and whatever the
 * money setting holds: whole seconds, as the token's times are.
 */
async function steppedUp(tx: TenantQuery, context: CommandContext): Promise<boolean> {
  const clock = await tx.query<{ readonly now: number }>(
    'select floor(extract(epoch from now()))::float8 as now',
  );
  const now = clock[0]?.now ?? Number.POSITIVE_INFINITY;
  return judgeStepUp(context.session, now) === 'fresh';
}

/** Whether the member holds a business-wide grant the caller does not. */
async function outranks(tx: TenantQuery, personId: string, callerId: string): Promise<boolean> {
  const wide = (await heldPermissions(tx)).filter((each) => each.scope.kind === 'business');
  const keys = (id: string) =>
    new Set(
      wide
        .filter((each) => each.personId === id)
        .map((each) => `${each.collection}:${each.action}`),
    );
  const caller = keys(callerId);
  return [...keys(personId)].some((key) => !caller.has(key));
}

/**
 * The member's verified factor and the one sign-in login that holds it, the
 * login's subject locked first (`liveFactor`). None or several logins, or a
 * login live in another business, is refused in the one set of words.
 */
async function heldFactor(
  tx: TenantQuery,
  personId: string,
): Promise<
  | {
      readonly login: { readonly id: string; readonly subject: string };
      readonly factor: SecondFactor;
    }
  | Refused
> {
  const logins = await tx.query<{ readonly id: string; readonly subject: string }>(
    `select l.id, l.subject
       from public.person_logins pl
       join public.logins l on l.business_id = pl.business_id and l.id = pl.login_id
      where pl.business_id = $1 and pl.person_id = $2::uuid and pl.active
        and l.provider = 'supabase'`,
    [tx.businessId, personId],
  );
  const login = logins.length === 1 ? logins[0] : undefined;
  if (login === undefined) return resetRefused();
  const factor = await liveFactor(tx, personId, { lock: login.subject });
  if (factor?.status !== 'verified') {
    return refused(refuseCommand('FACTOR_NOT_ENROLLED', [], NOT_ENROLLED_FIXES));
  }
  // Holds to the commit only because no path maps a login meanwhile: any path
  // that maps a login into a business must take the subject lock `liveFactor`
  // took above, first (SEC-B1 M3).
  if (await factorLoginLiveElsewhere(tx, login.id)) return resetRefused();
  return { login, factor };
}
