// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's own availability (MP-7-10, CS-7.27, `availability set` · audited).
//
// It is the person's own account and nobody else's: the row it writes is the
// signed-in person's, named by their session and never by the body, so a body
// naming anyone is refused as a field it does not take. No agent holds it, so
// it is served on the person prefix alone. The Team panel is staff only: a
// client of the business is answered as for a thing it cannot see.
//
// The row and its audit event commit together, or neither does. A refusal
// writes nothing.

import { payloadDigest } from '../../../core-digest/src/index.ts';
import { withStanding } from '../../../core-records/src/index.ts';
import type {
  BusinessId,
  Database,
  Session,
  VerifiedSubject,
} from '../../../core-records/src/index.ts';
import { isInternalReader } from '../reads/tasks.ts';
import { writeAuditEvent } from './audit.ts';
import { asCallerVisible, refuseCommand, refuseNotFound, type CommandRefusal } from './refusal.ts';

export const AVAILABILITY_COMMAND = 'availability.set';
export const REASON_LIMIT = 140;

export type AvailabilityState = 'available' | 'away';

export interface Availability {
  readonly state: AvailabilityState;
  readonly reason: string | null;
}

const FIELDS = new Set(['state', 'reason']);

const STATE_FIXES = ["Send state as 'available' or 'away'."];
const REASON_FIXES = [
  `Send reason as text of 1 to ${String(REASON_LIMIT)} characters, or leave it out.`,
  'Available carries no reason; clearing away clears it.',
];
const BODY_FIXES = ['Send state, and reason when away. Nothing else: it is your own account.'];

/** The body as the command takes it, or the refusal it meets before any lookup. */
export function availabilityOf(
  body: Readonly<Record<string, unknown>>,
): Availability | CommandRefusal {
  const unknown = Object.keys(body).filter((field) => !FIELDS.has(field));
  if (unknown.length > 0) return refuseCommand('COMMAND_BODY_INVALID', unknown, BODY_FIXES);
  const { state, reason } = body;
  if (state !== 'available' && state !== 'away') {
    return refuseCommand('FIELD_VALUE_INVALID', ['state'], STATE_FIXES);
  }
  if (reason === undefined || reason === null) return { state, reason: null };
  const fits =
    typeof reason === 'string' &&
    state === 'away' &&
    reason.trim().length > 0 &&
    reason.length <= REASON_LIMIT;
  return fits ? { state, reason } : refuseCommand('FIELD_VALUE_INVALID', ['reason'], REASON_FIXES);
}

/** The Team panel is staff only; past that, the body's own refusal, if any. */
function refusalFor(
  session: Session,
  asked: Availability | CommandRefusal,
): CommandRefusal | undefined {
  if (!isInternalReader(session.roleKey)) return refuseNotFound();
  return 'refused' in asked ? asked : undefined;
}

/**
 * Set the signed-in person's own availability, with its audit event, in one
 * transaction. A refusal of a signed-in person is audited too, refused and
 * with its code (I13), and writes no row; a caller with no standing here is
 * refused before there is anyone to audit.
 */
export async function setOwnAvailability(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  body: Readonly<Record<string, unknown>>,
): Promise<{ readonly availability: Availability } | CommandRefusal> {
  const asked = availabilityOf(body);
  const outcome = await withStanding(database, businessId, presented, async (tx, session) => {
    const wanted = 'refused' in asked ? undefined : asked;
    const refusal = refusalFor(session, asked);
    await writeAuditEvent(tx, {
      actorId: session.actorId,
      command: AVAILABILITY_COMMAND,
      outcome: refusal === undefined ? 'applied' : 'refused',
      refusalCode: refusal?.code ?? null,
      payloadDigest: payloadDigest(wanted ?? { person: session.personId }),
    });
    if (refusal !== undefined || wanted === undefined) return refusal ?? refuseNotFound();
    await tx.query(
      `insert into public.person_availability as a (business_id, person_id, state, reason)
            values ($1, $2, $3, $4)
       on conflict (business_id, person_id)
       do update set state = excluded.state, reason = excluded.reason, set_at = now()`,
      [tx.businessId, session.personId, wanted.state, wanted.reason],
    );
    return { availability: wanted };
  });
  return 'refused' in outcome ? asCallerVisible(outcome) : outcome;
}
