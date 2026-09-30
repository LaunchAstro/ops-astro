// SPDX-License-Identifier: AGPL-3.0-only
//
// What a proposal lineage has on record: its decision chain as stored, the
// money its approvals set aside, the lineage's own reject on its header (T3a),
// and the two ways this view prints a number or a stored value. `proposals.tsx` holds the section and says why each
// part draws what it draws.

import type { ReactElement } from 'react';
import { drawRunState } from '@launchastro/ui';
import type { OperationsClient } from '../operations/client.ts';
import { useCommand } from '../records/use-command.ts';
import type {
  DecisionLink as ProposalDecision,
  ProposalView as ProposalLineage,
  ReservationView as ProposalReservation,
} from '../../../../packages/core-wire/src/index.ts';
import { lapsed, settled, type DecisionNote } from './gate-controls.tsx';

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
          {/* T3e1: a drop is drawn in its own words, one per cause, and never
              as a person's cancellation. */}
          {reservation.attempt.dropCause === undefined || reservation.attempt.dropCause === null
            ? null
            : ` · ${
                drawRunState({
                  state: 'waiting',
                  waitReason: `dropped_${reservation.attempt.dropCause}`,
                }).word
              }`}
        </span>
      )}
    </div>
  );
}

/** The lineage's header props that its reject reads (`proposals.tsx` passes its own). */
interface RejectProps {
  readonly client: OperationsClient;
  readonly lineage: ProposalLineage;
  readonly note: DecisionNote | null;
  readonly onDecided: (note: DecisionNote | null) => void;
  readonly onChanged: () => void;
}

/**
 * "Reject this proposal" (T3a, package 2 item 4): the lineage's own action on
 * its header, outside the gate card, and on offer whenever the lineage is live
 * and its newest version's gate is open, the revision bound included. It is
 * `task.decide`'s reject on that gate and version, at parity with the API and
 * the command line; the server decides under its locks, and a reject there
 * ends the lineage for good. A terminal lineage draws none.
 */
export function RejectProposal(props: RejectProps): ReactElement | null {
  const { busy, run } = useCommand();
  const { lineage } = props;
  const head = lineage.versions[0];
  const gate = head?.gate ?? null;
  if (lineage.state !== 'live' || head === undefined || gate === null) return null;
  if (gate.state !== 'pending' || lapsed(gate) || props.note?.closed === true) return null;
  const reject = (): void => {
    if (busy) return;
    props.onDecided(null);
    run(
      () =>
        props.client.mutate('task.decide', {
          gateId: gate.id,
          versionId: head.versionId,
          decision: 'reject',
          note: 'Rejected from the task page.',
        }),
      (settlement) => {
        settled(settlement, { ...props, gate, lineageId: lineage.lineageId });
      },
    );
  };
  return (
    <button
      className="btn"
      data-lineage-action="reject"
      data-reject-gate={gate.id}
      data-reject-version={head.versionId}
      disabled={busy}
      onClick={reject}
      type="button"
    >
      Reject this proposal
    </button>
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
