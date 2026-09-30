// SPDX-License-Identifier: AGPL-3.0-only
//
// The gate's controls on a proposal version: request changes and approve,
// escalate at the revision bound (T3a), or the one reason none is on offer. Split out of `proposals.tsx` to keep
// that file under its 500-line limit; the reasoning for what the controls send
// and how a refusal is quoted is in `proposals.tsx`'s header.

import { useState, type ReactElement } from 'react';
import type { OperationsClient } from '../operations/client.ts';
import type {
  PersonView as TaskPerson,
  ProposalVersionView as ProposalVersion,
} from '../../../../packages/core-wire/src/index.ts';
import { useCommand, type Settlement } from '../records/use-command.ts';

/** What a refused decision left behind, held above the read that follows it. */
export interface DecisionNote {
  /** The server's own words, as `describeFailure` renders them. */
  readonly because: string;
  /** Set when the refusal was about this reader's authority, not this version. */
  readonly closed: boolean;
  /** The gate the refused decision was about. The text is drawn under it alone. */
  readonly gateId: string;
  /** Its lineage, where the text is drawn when a reread no longer lists the gate. */
  readonly lineageId: string;
}

/**
 * Whether the gate passed its deadline undecided, on the server's answer.
 * A decided gate never reads as expired, whatever `expired` says.
 */
export function lapsed(gate: NonNullable<ProposalVersion['gate']>): boolean {
  return gate.state === 'expired' || (gate.state === 'pending' && gate.expired);
}

interface DecideProps {
  readonly client: OperationsClient;
  readonly gate: NonNullable<ProposalVersion['gate']>;
  readonly versionId: string;
  readonly lineageId: string;
  readonly lineageState: string;
  readonly note: DecisionNote | null;
  readonly onDecided: (note: DecisionNote | null) => void;
  readonly onChanged: () => void;
  /** The gate's version is not the lineage's newest, so approve is disabled. */
  readonly stale: boolean;
  readonly persons: readonly TaskPerson[];
}

export function Decide(props: DecideProps): ReactElement {
  const { gate } = props;
  const { busy, run } = useCommand();
  const [recipient, setRecipient] = useState('');
  const closed = props.note?.closed === true;
  // Whether the note is about this gate, which picks the wording below. The
  // note's own text is drawn by `Version`, under the gate it names.
  const refused = props.note !== null && props.note.gateId === gate.id;
  // Four reasons a decision is not on offer, and the person is told which.
  const why = closed
    ? refused
      ? 'The server refused your decision on this gate, so the controls are closed rather than asking again on your behalf.'
      : 'The server refused a decision of yours on this task, so these controls are closed too rather than asking again on your behalf.'
    : lapsed(gate)
      ? `This gate expired: its deadline${gate.expiresAt === null ? '' : `, ${gate.expiresAt},`} passed without a decision, on the server’s own clock, so nobody may decide it now. A new version of the proposal raises a new gate.`
      : gate.state !== 'pending'
        ? `This gate is ${gate.state} and a decided gate is not decided twice.`
        : props.lineageState === 'live'
          ? null
          : `This lineage is ${props.lineageState}, and a lineage that has ended is not decided again. An authorised restart opens a new one.`;

  const decide = (decision: 'approve' | 'request_changes' | 'escalate'): void => {
    if (busy || closed) return;
    props.onDecided(null);
    run(
      // **The version is the one drawn above this button**, taken from the same
      // `task.read` answer as the evidence. No separate fetch, no draft: the
      // server compares this against the live version under the locks, and a
      // page that had gone stale is told so rather than deciding by accident.
      () =>
        props.client.mutate('task.decide', {
          gateId: gate.id,
          versionId: props.versionId,
          decision,
          note: `Decided from the task page (${decision}).`,
          ...(decision === 'escalate' ? { recipientPersonId: recipient } : {}),
        }),
      (settlement) => {
        settled(settlement, props);
      },
    );
  };

  return (
    <div className="btnrow" data-decide="controls">
      {why === null ? (
        <>
          {/* Two controls and no third: reject is the proposal header's own
              action (T3a), never a gate control (package 2 item 4). */}
          <button
            className="btn"
            data-decide="request_changes"
            data-gate-id={gate.id}
            data-version-id={props.versionId}
            disabled={busy}
            onClick={() => {
              decide('request_changes');
            }}
            type="button"
          >
            Request changes
          </button>
          <button
            className="btn btn--primary"
            data-decide="approve"
            data-gate-id={gate.id}
            data-version-id={props.versionId}
            disabled={busy || props.stale}
            onClick={() => {
              if (!props.stale) decide('approve');
            }}
            type="button"
          >
            {busy ? 'Deciding…' : 'Approve this version'}
          </button>
          {/* Escalate (T3a) only at the bound, where a third round is refused.
              New behaviour with no drawing behind it (specification 13.2). */}
          {gate.round >= 3 ? (
            <div data-escalate="form" data-ui-reference="none">
              <select
                aria-label="Escalate to"
                data-escalate="recipient"
                disabled={busy}
                onChange={(event) => {
                  setRecipient(event.target.value);
                }}
                value={recipient}
              >
                <option value="">Choose who decides it</option>
                {props.persons.map((person) => (
                  <option key={person.personId} value={person.personId}>
                    {person.name}
                  </option>
                ))}
              </select>
              <button
                className="btn"
                data-decide="escalate"
                data-gate-id={gate.id}
                disabled={busy || recipient === ''}
                onClick={() => {
                  if (recipient !== '') decide('escalate');
                }}
                type="button"
              >
                Escalate
              </button>
            </div>
          ) : null}
          <p className="card__sub" data-gate="notice">
            This demonstration changes nothing outside the app: its one effect is a team-only
            comment on this task.
          </p>
        </>
      ) : (
        <p className="card__sub" data-decide="closed">
          {why}
        </p>
      )}
    </div>
  );
}

/**
 * What the server said about a decision, and what the page does next.
 *
 * Every outcome ends in a reread, refusal or not. A refusal about the version or
 * the gate means this page was describing a record that has moved, and the only
 * honest response to that is to read it again; a success has to be read back
 * because the reservation the approval created is the server's, not this
 * screen's guess at what an approval does.
 */
export function settled(
  settlement: Settlement,
  props: Pick<DecideProps, 'onDecided' | 'onChanged' | 'lineageId'> & {
    readonly gate: { readonly id: string };
  },
): void {
  if (settlement.kind === 'ok') {
    props.onDecided(null);
    props.onChanged();
    return;
  }
  // `SCOPE_NOT_GRANTED` is about this reader rather than about this version, so
  // it closes the control. Everything else is about the record, and the record
  // is what gets read again.
  props.onDecided({
    because: settlement.because,
    closed: settlement.kind === 'closed',
    gateId: props.gate.id,
    lineageId: props.lineageId,
  });
  props.onChanged();
}
