// SPDX-License-Identifier: AGPL-3.0-only
//
// The one transaction shape every second-factor act (`account-factor.ts`) runs
// in, before and after its call to the sign-in provider: the caller resolved,
// the act's check, the code recorded, and the act's audit event, together.
// Who is asking (`FactorCaller`) is declared here, so the modules split from
// `account-factor.ts` take it from here and none imports that file back.

import { ENDED_FIXES, sessionEnded, withSession } from '../../../core-records/src/index.ts';
import type {
  BusinessId,
  Database,
  Session,
  TenantQuery,
  VerifiedSubject,
} from '../../../core-records/src/index.ts';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import { recordCode } from './account-factor-checks.ts';
import { writeAuditEvent } from './audit.ts';
import { asCallerVisible, refuseCommand, type CommandRefusal } from './refusal.ts';

/** Who is asking and what they presented, as the API door admitted them. */
export interface FactorCaller {
  readonly database: Database;
  readonly businessId: BusinessId;
  readonly presented: VerifiedSubject;
  /** The person's own bearer, passed to the provider and nowhere else. */
  readonly accessToken: string;
}

export type Act = 'account.factor_enrol' | 'account.factor_verify' | 'account.factor_remove';

/**
 * One transaction on the factor path: resolve the caller (their factor is not
 * required yet, since these acts are how they give it), run `check`, and write
 * the act's audit event in the same transaction.
 *
 * The check before the provider call records only a refusal, or, passed for a
 * code (`attempt`), the code as sent, under the login's lock (`recordCode`);
 * the act's own event, applied or refused, is written after the call beside
 * the record it changes, and names the same `attempt`, with the code recorded
 * as answered only when the provider proved it good (`proven`).
 */
export async function judged(
  caller: FactorCaller & {
    readonly attempt?: string;
    readonly operation?: string;
    readonly proven?: boolean;
  },
  act: Act,
  check: (tx: TenantQuery, session: Session) => Promise<CommandRefusal | undefined>,
  stage: 'before' | 'after' = 'after',
): Promise<CommandRefusal | undefined> {
  const outcome = await withSession(
    caller.database,
    caller.businessId,
    caller.presented,
    async (tx, session) => {
      const settle = async (refusal: CommandRefusal | undefined) => {
        await recordCode(tx, session, caller, stage, refusal);
        if (stage === 'before' && refusal === undefined) return;
        await writeAuditEvent(tx, {
          actorId: session.actorId,
          command: act,
          operationId: caller.attempt ?? caller.operation ?? null,
          outcome: refusal === undefined ? 'applied' : 'refused',
          refusalCode: refusal?.code ?? null,
          payloadDigest: payloadDigest({ command: act, person: session.personId }),
        });
        return refusal;
      };
      await tx.query('savepoint factor_act');
      const refusal = await settle(await check(tx, session));
      // The session asked again after the act's last wait (the factor lock,
      // the audit chain): one signed out meanwhile undoes the act, whatever
      // it decided (a refusal can change records too: a verify's losing
      // enrolment is removed), and the refusal is recorded in its place (#443).
      if (stage === 'before') return refusal;
      if (!(await sessionEnded(tx, caller.presented))) return refusal;
      await tx.query('rollback to savepoint factor_act');
      // The rollback also takes back the ending `sessionEnded` records for a
      // session refused while a reset is open; asked again, it stands.
      await sessionEnded(tx, caller.presented);
      return await settle(refuseCommand('AUTH_SESSION_EXPIRED', [], ENDED_FIXES));
    },
    'enrolling',
  );
  if (outcome === undefined) return undefined;
  return asCallerVisible(outcome);
}
