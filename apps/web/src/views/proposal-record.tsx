// SPDX-License-Identifier: AGPL-3.0-only
//
// What a proposal lineage has on record: its decision chain as stored, the
// money its approvals set aside, and the two ways this view prints a number
// or a stored value. `proposals.tsx` holds the section and says why each
// part draws what it draws.

import type { ReactElement } from 'react';
import type {
  DecisionLink as ProposalDecision,
  ReservationView as ProposalReservation,
} from '../../../../packages/core-wire/src/index.ts';

export function Chain(props: {
  readonly decisions: readonly ProposalDecision[];
}): ReactElement | null {
  if (props.decisions.length === 0) return null;
  return (
    <div className="sbact" data-decisions="chain">
      <div className="sb__sh">
        <span className="sb__k">Decisions</span>
        <span className="sbact__meta">{props.decisions.length} link(s), as stored</span>
      </div>
      {props.decisions.map((link) => (
        <div className="sbact__row" data-decision-seq={link.seq} key={`${String(link.seq)}`}>
          <span className="sb__state">{link.decision}</span>
          <span className="sbact__meta">
            seq {link.seq} · round {link.round} · by {link.decidedByPersonId ?? 'nobody recorded'} ·{' '}
            {link.decidedAt}
          </span>
          {/* The stored hash and the stored previous hash. Nothing here
              recomputes either: a recomputed hash drawn as the stored one would
              make a tampered link look sound. */}
          <span className="sbact__meta" data-decision="hash">
            hash {link.hash ?? 'none stored'} · after {link.prevHash ?? 'nothing'}
          </span>
        </div>
      ))}
    </div>
  );
}

/** T3b: a step dispatched and never confirmed. Its hold is an unknown cost, not money spent. */
const isUnknown = (reservation: ProposalReservation): boolean =>
  reservation.attempt?.state === 'liability_unknown';

export function Reservations(props: {
  readonly reservations: readonly ProposalReservation[];
}): ReactElement | null {
  const unknown = props.reservations.filter(isUnknown);
  const known = props.reservations.filter((reservation) => !isUnknown(reservation));
  return (
    <>
      {unknown.length === 0 ? null : <UnknownCosts reservations={unknown} />}
      {known.length === 0 ? null : <Known reservations={known} />}
    </>
  );
}

/**
 * Drawn apart from settled money, and raised for a person: the whole hold
 * stays set aside until someone records what happened (T3c, T3d1).
 */
function UnknownCosts(props: {
  readonly reservations: readonly ProposalReservation[];
}): ReactElement {
  return (
    <div className="sbact" data-unknown-liabilities="list">
      <div className="sb__sh">
        <span className="sb__k">Unknown cost, needs a person</span>
      </div>
      {props.reservations.map((reservation) => (
        <div className="sbact__row" data-unknown-liability={reservation.id} key={reservation.id}>
          <span className="sb__state">started, not confirmed</span>
          <span className="sbact__meta">
            {money(reservation.heldMinor ?? 0, '')} held as an unknown cost: it needs a person to
            record what happened
          </span>
        </div>
      ))}
    </div>
  );
}

function Known(props: { readonly reservations: readonly ProposalReservation[] }): ReactElement {
  return (
    <div className="sbact" data-reservations="list">
      <div className="sb__sh">
        <span className="sb__k">Money set aside</span>
      </div>
      {props.reservations.map((reservation) => (
        <ReservationRow key={reservation.id} reservation={reservation} />
      ))}
    </div>
  );
}

/** One reservation: what it held, what it spent, and its lease and attempt. */
function ReservationRow(props: { readonly reservation: ProposalReservation }): ReactElement {
  const { reservation } = props;
  return (
    <div
      className="sbact__row"
      data-reservation-id={reservation.id}
      data-reservation-state={reservation.state}
    >
      <span className="sb__state">{reservation.state}</span>
      <span className="sbact__meta">
        {/* Held and actual are two different numbers and both are drawn: a
            reservation that held more than the work spent is the ordinary
            case, and one number cannot say which of the two it is. */}
        held {reservation.heldMinor === null ? 'nothing' : money(reservation.heldMinor, '')} · spent{' '}
        {reservation.actualMinor === null ? 'not reported' : money(reservation.actualMinor, '')}
        {reservation.releasedMinor === undefined || reservation.releasedMinor === null
          ? null
          : ` · released ${money(reservation.releasedMinor, '')}`}
        {reservation.classifiedCause === null ? null : ` · ${reservation.classifiedCause}`}
      </span>
      {reservation.lease === null ? (
        <span className="sbact__meta" data-lease="none">
          no lease
        </span>
      ) : (
        <span className="sbact__meta" data-lease-state={reservation.lease.state}>
          lease {reservation.lease.state}, fence {reservation.lease.fence}
          {reservation.lease.expiresAt === null ? '' : `, until ${reservation.lease.expiresAt}`}
        </span>
      )}
      {reservation.attempt === null ? (
        <span className="sbact__meta" data-attempt="none">
          no attempt
        </span>
      ) : (
        <span className="sbact__meta" data-attempt-state={reservation.attempt.state}>
          attempt {reservation.attempt.state}
        </span>
      )}
    </div>
  );
}

/** Minor units as money a person reads, with the currency the proposal named. */
export function money(minor: number, currency: string): string {
  const amount = (minor / 100).toLocaleString('en-AU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === '' ? amount : `${currency} ${amount}`;
}

/**
 * A stored value, printed rather than interpreted.
 *
 * The evidence body and the proposal payload are whatever the renderer and the
 * proposer put there. A screen that walked them looking for fields it knew would
 * silently drop the ones it did not, and a decision made on a partial reading of
 * the evidence is the failure the gate exists to prevent.
 */
export function stored(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
