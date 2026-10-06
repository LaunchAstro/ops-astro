// SPDX-License-Identifier: AGPL-3.0-only
//
// C40's reset (account-password.ts), step 6 in each business: the sessions
// seen there end, and in the token's business the one audit row.

import {
  endOtherSeenSessions,
  endSeenSessions,
  type Session,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import { writeAuditEvent, type WrittenAuditEvent } from './audit.ts';

/** The audit command a reset's password set records. */
export const RESET_COMMAND = 'account.password_changed';

/**
 * Step 6: the sessions seen in a business end; given the `subject` (a reset
 * that set nothing), every session signed in until now too, to the instant
 * (0063), as the settle's second is not.
 */
export const endIn = async (tx: TenantQuery, session: Session, subject?: string): Promise<number> =>
  await (subject === undefined
    ? endSeenSessions(tx, session.personId, undefined, 'end_others')
    : endOtherSeenSessions(tx, session.personId, undefined, 'end_others', subject));

/** Step 6's one audit row, in the token's business. */
export const audited = async (tx: TenantQuery, session: Session): Promise<WrittenAuditEvent> =>
  await writeAuditEvent(tx, {
    actorId: session.actorId,
    command: RESET_COMMAND,
    outcome: 'applied',
    refusalCode: null,
    payloadDigest: payloadDigest({ command: RESET_COMMAND, person: session.personId }),
  });
