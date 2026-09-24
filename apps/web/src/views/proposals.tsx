// SPDX-License-Identifier: AGPL-3.0-only
//
// The proposals on a task: what was proposed, what the evidence said, who
// decided it, and the control that decides the version on the screen.
//
// **Everything here comes out of one answer.** `task.read` carries the whole
// projection (`docs/local/API.md`, "Proposal projection"), so the `versionId`
// the approve button sends is the `versionId` of the version whose evidence and
// digest are drawn beside it. That is the point of the projection riding on the
// detail rather than sitting behind a read of its own: a screen that fetched the
// version separately could offer a decision on something it never displayed,
// and `task.decide` compares the exact version under the locks precisely so
// that cannot pass unnoticed.
//
// **Nothing here is recomputed.** The evidence pack is printed as it was stored,
// the digests are printed as they arrived, and the decision chain is the stored
// rows with their stored hashes. Re-rendering evidence, or recomputing a hash
// and drawing it as though it were the stored one, would make exactly the
// tampering these records exist to expose invisible. So this file formats money
// and dates for reading and leaves every other value alone.
//
// **The expiry is the server's answer, not the browser's arithmetic.** A gate
// carries both `expiresAt` and `expired`, and the controls close on `expired`. A
// clock a few minutes out would otherwise either offer a decision the server is
// certain to refuse or hide one it would have accepted, and the gate — not the
// reader's laptop — is what the deadline belongs to.
//
// **Only an undecided gate expires.** `task.read` reads a gate stored `pending`
// past its deadline as `state: 'expired'` (Nathan's decision, 23 September
// 2026: show expired on read, preserve the stored record). A decided gate keeps
// its outcome whatever the clock says, so `lapsed` below draws an approved,
// rejected or sent-back gate by its outcome even if `expired` arrived true.
//
// **A refused decision is quoted and the page is read again.** A refusal like
// `VERSION_SUPERSEDED` is the server saying this page is no longer describing
// the record, so the answer to it is a fresh read rather than a retry. The
// refusal text is held above the read (`TaskDetail.tsx`) because the reread
// unmounts everything below it, and a message that vanished with the thing it
// was explaining would leave a person watching the screen change for no stated
// reason.
//
// **A refusal is quoted under the gate it was about.** The note carries the
// gate the refused control sent, so a task with two lineages does not draw one
// gate's refusal beside the other gate's live controls. It is drawn under that
// gate's version whether or not the version is still the head: a refusal
// because the gate was superseded arrives with a reread that has moved the
// head on, and a quote kept only beside the head's controls would be drawn
// nowhere. A reread that no longer lists the gate at all gets the quote under
// the lineage it was about, and failing that above the list.
//
// **A proposal whose answer was lost is sent again as the same attempt.** The
// server may have stored it, so a retry of the unchanged form carries the same
// `operationId` and the register replays the original answer rather than
// opening a second lineage with its own gate. The retry resends the revision
// the attempt was first sent at, not the one the page now shows: the register
// compares every field but the identity, so a newer revision after a reread
// would be refused `OPERATION_ID_REUSED` rather than replayed. If the first
// attempt was never stored, that old revision is the server's `VERSION_STALE`,
// which the stale path handles. Changing the form is a different proposal and
// gets a new one.
//
// **What the person typed is held above the read** (`TaskDetail.tsx`), with
// the attempt, because every reread remounts this form. A proposal refused
// `VERSION_STALE` rereads the task, keeps the fields and quotes the refusal, so
// the next press goes out against the revision the page now shows.
//
// **A reader without the grant is refused once.** There is no capability read in
// this build, so this screen cannot know whether a person may decide before it
// asks. It asks once, quotes the server's own code, and then stops offering a
// control that has already been refused for this reader. That closure is about
// the reader, so it closes every gate on the task, and the propose form's own
// closure is held above the read for the same reason the note is.
//
// **An ended lineage is not offered for a decision.** Cancelling a lineage
// leaves its head gate stored `pending`, and `task.decide` refuses any decision
// on it with `LINEAGE_TERMINAL`. The lineage state is in the same answer as the
// gate, so the controls close on it rather than inviting that refusal.

import { type FormEvent, type ReactElement } from 'react';
import { PaneEmpty } from '@launchastro/ui';
import type { OperationsClient } from '../operations/client.ts';
import type {
  ProposalDecision,
  ProposalLineage,
  ProposalReservation,
  ProposalVersion,
} from '../operations/shapes.ts';
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

/** Where a note is drawn: under its gate, its lineage, or above the list. */
type NoteAt = 'gate' | 'lineage' | 'section';

function noteAt(note: DecisionNote | null, proposals: readonly ProposalLineage[]): NoteAt | null {
  if (note === null) return null;
  const drawn = proposals.flatMap((lineage) => lineage.versions);
  if (drawn.some((version) => version.gate?.id === note.gateId)) return 'gate';
  if (proposals.some((lineage) => lineage.lineageId === note.lineageId)) return 'lineage';
  return 'section';
}

export interface ProposalsProps {
  readonly client: OperationsClient;
  /** Absent means the answer carried no projection at all. Not the same as none. */
  readonly proposals: readonly ProposalLineage[] | undefined;
  readonly recordId: string;
  /** The revision the page holds; a proposal is offered against it. */
  readonly revision: number;
  readonly note: DecisionNote | null;
  readonly onDecided: (note: DecisionNote | null) => void;
  /** The server's refusal of a proposal on this reader's authority, held above the read. */
  readonly proposeRefusal: string | null;
  readonly onProposeRefused: (because: string) => void;
  /** The unsent proposal, held above the read so a reread keeps it. */
  readonly proposeDraft: ProposeDraft | null;
  readonly onProposeDraft: (next: ProposeDraft | null) => void;
  readonly onChanged: () => void;
}

/**
 * The currency the seeded budget cap is kept in. `scripts/local-seed.mjs`
 * inserts every business's cap in AUD, and `task.decide` refuses a version in
 * any other currency with `CAP_BINDING_MISMATCH`, so offering another would
 * make a proposal nobody can approve.
 */
const CURRENCIES: readonly string[] = ['AUD'];

export function Proposals(props: ProposalsProps): ReactElement {
  const at = noteAt(props.note, props.proposals ?? []);
  return (
    <section className="sb__sect" data-proposals="section">
      <div className="sb__sh">
        <span className="sb__k">Proposals</span>
        <span className="sbact__meta">{countWord(props.proposals)}</span>
      </div>

      {props.proposals === undefined ? (
        // The answer did not carry the projection. Drawing "no proposals" here
        // would be this screen reporting an absence it never established.
        <p className="card__sub" data-proposals="not-carried">
          This task read carried no proposal projection, so what has been proposed on this task is
          not known here. It is not that there is nothing: it is that nothing was read.
        </p>
      ) : props.proposals.length === 0 ? (
        <div data-proposals="none">
          <PaneEmpty say="Nothing has been proposed on this one yet." />
        </div>
      ) : (
        <div className="stack" data-proposals="list">
          {at === 'section' ? <Refusal note={props.note} /> : null}
          {props.proposals.map((lineage) => (
            <Lineage
              client={props.client}
              key={lineage.lineageId}
              lineage={lineage}
              note={props.note}
              noteAt={at}
              onChanged={props.onChanged}
              onDecided={props.onDecided}
            />
          ))}
        </div>
      )}

      <Propose
        client={props.client}
        draft={props.proposeDraft}
        onChanged={props.onChanged}
        onDraft={props.onProposeDraft}
        onRefused={props.onProposeRefused}
        recordId={props.recordId}
        refusal={props.proposeRefusal}
        revision={props.revision}
      />
    </section>
  );
}

interface LineageProps {
  readonly client: OperationsClient;
  readonly lineage: ProposalLineage;
  readonly note: DecisionNote | null;
  readonly noteAt: NoteAt | null;
  readonly onDecided: (note: DecisionNote | null) => void;
  readonly onChanged: () => void;
}

function Lineage(props: LineageProps): ReactElement {
  const { lineage } = props;
  return (
    <article
      className="sb__sect"
      data-lineage-id={lineage.lineageId}
      data-lineage-state={lineage.state}
    >
      <div className="sb__sh">
        <span className="sb__k">Lineage</span>
        <span className="sb__state">{lineage.state}</span>
        <span className="sbact__meta">{lineage.lineageId}</span>
      </div>
      {props.noteAt === 'lineage' && props.note?.lineageId === lineage.lineageId ? (
        <Refusal note={props.note} />
      ) : null}

      {lineage.versions.map((version, index) => (
        <Version
          client={props.client}
          // The head of the list is the live one, and only it may be decided.
          // The older versions are here to be read, not to be acted on.
          head={index === 0}
          key={version.versionId}
          lineageId={lineage.lineageId}
          lineageState={lineage.state}
          note={props.note}
          onChanged={props.onChanged}
          onDecided={props.onDecided}
          version={version}
        />
      ))}

      <Chain decisions={lineage.decisions} />
      <Reservations reservations={lineage.reservations} />
    </article>
  );
}

interface VersionProps {
  readonly client: OperationsClient;
  readonly version: ProposalVersion;
  readonly head: boolean;
  readonly lineageId: string;
  /** The lineage's state from the same answer. Only a `live` lineage is decided. */
  readonly lineageState: string;
  readonly note: DecisionNote | null;
  readonly onDecided: (note: DecisionNote | null) => void;
  readonly onChanged: () => void;
}

function Version(props: VersionProps): ReactElement {
  const { version } = props;
  const gate = version.gate;
  return (
    <div
      className="sb__sect"
      data-version={version.version}
      data-version-id={version.versionId}
      data-version-superseded={version.supersededAt === null ? 'false' : 'true'}
    >
      <div className="sb__sh">
        <span className="sb__k">Version {version.version}</span>
        <span className="sb__state">{version.purpose}</span>
        <span className="sbact__meta" data-version="ceiling">
          up to {money(version.maximumMinor, version.currency)}
        </span>
      </div>
      <div className="card__sub">
        {/* The digest is the proposal's own identity for a decider: two
            versions with the same digest are the same proposal, and a digest
            that changed is a different one wearing the same number. */}
        <span data-version="digest">payload digest {version.payloadDigest}</span>
        {version.supersededAt === null ? null : <span> · superseded {version.supersededAt}</span>}
        {version.runId === null ? null : <span> · run {version.runId}</span>}
      </div>

      {version.payload === undefined ? null : (
        <pre className="card__body" data-version="payload">
          {stored(version.payload)}
        </pre>
      )}

      {version.evidence === null ? (
        <p className="card__sub" data-evidence="none">
          No evidence pack was stored against this version.
        </p>
      ) : (
        <div className="stack" data-evidence="pack">
          <div className="card__sub">
            <span data-evidence="renderer">rendered by {version.evidence.renderer}</span>
            <span data-evidence="digest"> · digest {version.evidence.digest}</span>
          </div>
          {/* As stored. This screen does not re-render evidence, so what a
              decider reads is what the decision was signed over. */}
          <pre className="card__body" data-evidence="body">
            {stored(version.evidence.body)}
          </pre>
        </div>
      )}

      {gate === null ? (
        <p className="card__sub" data-gate="none">
          No approval gate was raised on this version.
        </p>
      ) : (
        <div
          className="card__sub"
          data-gate-expired={String(lapsed(gate))}
          data-gate-state={lapsed(gate) ? 'expired' : gate.state}
        >
          Gate {lapsed(gate) ? 'expired' : gate.state}, round {gate.round}
          {gate.expiresAt === null ? null : lapsed(gate) ? (
            <span data-gate="expired"> · deadline {gate.expiresAt} passed with no decision</span>
          ) : (
            <span> · expires {gate.expiresAt}</span>
          )}
        </div>
      )}

      {gate === null || !props.head ? null : (
        <Decide
          client={props.client}
          gate={gate}
          lineageId={props.lineageId}
          lineageState={props.lineageState}
          note={props.note}
          onChanged={props.onChanged}
          onDecided={props.onDecided}
          versionId={version.versionId}
        />
      )}
      {gate === null || props.note?.gateId !== gate.id ? null : <Refusal note={props.note} />}
    </div>
  );
}

/**
 * Whether the gate passed its deadline undecided, on the server's answer.
 * A decided gate never reads as expired, whatever `expired` says.
 */
function lapsed(gate: NonNullable<ProposalVersion['gate']>): boolean {
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
}

function Decide(props: DecideProps): ReactElement {
  const { gate } = props;
  const { busy, run } = useCommand();
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

  const decide = (decision: 'approve' | 'reject'): void => {
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
          <button
            className="btn btn--primary"
            data-decide="approve"
            data-gate-id={gate.id}
            data-version-id={props.versionId}
            disabled={busy}
            onClick={() => {
              decide('approve');
            }}
            type="button"
          >
            {busy ? 'Deciding…' : 'Approve this version'}
          </button>
          <button
            className="btn"
            data-decide="reject"
            data-gate-id={gate.id}
            data-version-id={props.versionId}
            disabled={busy}
            onClick={() => {
              decide('reject');
            }}
            type="button"
          >
            Reject
          </button>
        </>
      ) : (
        <p className="card__sub" data-decide="closed">
          {why}
        </p>
      )}
    </div>
  );
}

/** A refused decision, quoted as the server said it. */
function Refusal(props: { readonly note: DecisionNote | null }): ReactElement | null {
  if (props.note === null) return null;
  return (
    <p className="field__error" role="alert" data-decide="refusal" data-gate-id={props.note.gateId}>
      {props.note.because}
    </p>
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
function settled(settlement: Settlement, props: DecideProps): void {
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

function Chain(props: { readonly decisions: readonly ProposalDecision[] }): ReactElement | null {
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

function Reservations(props: {
  readonly reservations: readonly ProposalReservation[];
}): ReactElement | null {
  if (props.reservations.length === 0) return null;
  return (
    <div className="sbact" data-reservations="list">
      <div className="sb__sh">
        <span className="sb__k">Money set aside</span>
      </div>
      {props.reservations.map((reservation) => (
        <div
          className="sbact__row"
          data-reservation-id={reservation.id}
          data-reservation-state={reservation.state}
          key={reservation.id}
        >
          <span className="sb__state">{reservation.state}</span>
          <span className="sbact__meta">
            {/* Held and actual are two different numbers and both are drawn: a
                reservation that held more than the work spent is the ordinary
                case, and one number cannot say which of the two it is. */}
            held {reservation.heldMinor === null ? 'nothing' : money(reservation.heldMinor, '')} ·
            spent{' '}
            {reservation.actualMinor === null ? 'not reported' : money(reservation.actualMinor, '')}
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
      ))}
    </div>
  );
}

interface ProposeProps {
  readonly client: OperationsClient;
  readonly recordId: string;
  readonly revision: number;
  /** An earlier refusal on this reader's authority, which outlives the reread. */
  readonly refusal: string | null;
  readonly onRefused: (because: string) => void;
  readonly draft: ProposeDraft | null;
  readonly onDraft: (next: ProposeDraft | null) => void;
  readonly onChanged: () => void;
}

/** An unsent proposal: the fields, the attempt whose outcome is unknown, and a stale refusal. */
export interface ProposeDraft {
  readonly purpose: string;
  readonly maximum: string;
  readonly currency: string;
  readonly pending: PendingProposal | null;
  /** The server's `VERSION_STALE`, quoted across the reread it caused. */
  readonly stale: string | null;
}

const EMPTY_PROPOSAL: ProposeDraft = {
  purpose: '',
  maximum: '',
  currency: 'AUD',
  pending: null,
  stale: null,
};

/** A proposal whose outcome is not known, held so the retry is the same attempt. */
export interface PendingProposal {
  readonly operationId: string;
  /** The revision the attempt was sent at, resent with it so the register replays. */
  readonly revision: number;
  readonly purpose: string;
  readonly maximum: string;
  readonly currency: string;
}

function Propose(props: ProposeProps): ReactElement {
  const current = props.draft ?? EMPTY_PROPOSAL;
  // `pending` is the attempt nobody knows the outcome of, as the board's create
  // keeps one (`Projects.tsx`). `task.propose` leaves the task's revision
  // alone, so the revision check cannot catch a retry; only the `operationId`
  // can.
  const { purpose, maximum, currency, pending } = current;
  const put = (next: Partial<ProposeDraft>): void => {
    props.onDraft({ ...current, ...next });
  };
  const command = useCommand();
  const busy = command.busy;
  // The refusal is also held above the read, because a reread remounts this
  // form with a fresh command and the closure would otherwise be forgotten.
  const closed = command.closed || props.refusal !== null;
  const locked = busy || closed;
  const because = command.because ?? props.refusal;
  const run = command.run;

  const same = (attempt: PendingProposal | null): attempt is PendingProposal =>
    attempt !== null &&
    attempt.purpose === purpose &&
    attempt.maximum === maximum &&
    attempt.currency === currency;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (locked) return;
    const attempt = same(pending)
      ? pending
      : {
          operationId: props.client.newOperationId(),
          revision: props.revision,
          purpose,
          maximum,
          currency,
        };
    put({ pending: attempt, stale: null });
    run(
      () =>
        props.client.mutate(
          'task.propose',
          {
            recordId: props.recordId,
            purpose,
            // Money crosses the wire in minor units. The conversion happens once,
            // here, because three places that each convert are three places that
            // can disagree about what a dollar is.
            maximumMinor: minorOf(maximum),
            currency,
            payload: { step: purpose },
            // **`step` is an object, not the purpose again.** The contract is
            // `{ kind, payload }` (`commands/requests.ts`), and `proposeOnTask`
            // writes `step.kind` straight into `planned_steps.kind`, which is
            // `not null`. Sending the slug as a bare string put null in that
            // column and the handler threw, which the API reports as a 503 — so
            // the screen said "the API answered 503" and the person had no idea
            // their proposal was well formed and the client was not. The browser
            // case is what found it; the mounted stand-in had accepted anything.
            step: { kind: purpose, payload: { step: purpose } },
          },
          // The revision the attempt was made at: the page's for a new attempt,
          // the first send's for a retry. A proposal made against a task that has
          // moved on is the server's `VERSION_STALE`, not a silent write.
          { expectedRevision: attempt.revision, operationId: attempt.operationId },
        ),
      settledProposal,
    );
  };

  /**
   * What the server said about a proposal.
   *
   * A refusal about this reader's authority closes the form, because there is no
   * capability read to ask first and a control that has already been refused
   * should not keep inviting the same refusal. Anything else the person can
   * correct and send again. A success clears the form and reads the task, so the
   * version that appears is the server's rather than this form's own echo.
   */
  function settledProposal(settlement: Settlement): void {
    // An unknown outcome keeps the attempt; any answer from the server ends it.
    if (settlement.kind === 'unknown') return;
    if (settlement.kind === 'closed') props.onRefused(settlement.because);
    if (settlement.kind === 'stale') {
      // The task moved on. Keep the fields, read the task again, and say why.
      props.onDraft({ ...current, pending: null, stale: settlement.because });
      props.onChanged();
      return;
    }
    if (settlement.kind !== 'ok') {
      props.onDraft({ ...current, pending: null, stale: null });
      return;
    }
    props.onDraft(null);
    props.onChanged();
  }

  return (
    <form className="taskform" id="task-propose" onSubmit={submit}>
      <div className="sb__sh">
        <span className="sb__k">Propose something</span>
      </div>
      {because === null ? null : (
        <p className="field__error" role="alert" data-propose="refusal">
          {because}
        </p>
      )}
      {current.stale === null ? null : (
        <div role="alert" data-propose="stale">
          <p className="field__error">{current.stale}</p>
          <p className="card__sub">
            Somebody else moved this task on before your proposal was stored, so it was not. The
            task has been read again and your proposal is still here: propose it again if it still
            applies.
          </p>
        </div>
      )}
      <div className="field">
        <label className="tf__k" htmlFor="propose-purpose">
          What it is for
        </label>
        {/*
          The pattern is the database's own
          (`proposal_versions_purpose_shape`, migration 0010), asked for here
          rather than discovered as a failure: a purpose with a dot or a capital
          in it violates that check inside the handler, and the API reports a
          violated check as a 503 rather than as a refusal a person could act
          on. Asking for the shape the column accepts is the difference between
          a form that tells you and a form that breaks.
        */}
        <input
          className="input"
          disabled={locked}
          id="propose-purpose"
          onChange={(event) => {
            put({ purpose: event.target.value });
          }}
          pattern="[a-z][a-z0-9_]{0,62}"
          required
          title="Lower case, digits and underscores, starting with a letter."
          type="text"
          value={purpose}
        />
        <p className="card__sub">
          Lower case, digits and underscores, such as client_renewal_quote.
        </p>
      </div>
      <div className="field">
        <label className="tf__k" htmlFor="propose-maximum">
          The most it may spend
        </label>
        <input
          className="input"
          disabled={locked}
          id="propose-maximum"
          min="0"
          onChange={(event) => {
            put({ maximum: event.target.value });
          }}
          required
          step="0.01"
          type="number"
          value={maximum}
        />
      </div>
      <div className="field">
        <label className="tf__k" htmlFor="propose-currency">
          In
        </label>
        <select
          className="input"
          disabled={locked}
          id="propose-currency"
          onChange={(event) => {
            put({ currency: event.target.value });
          }}
          value={currency}
        >
          {CURRENCIES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </div>
      <button className="btn btn--primary" data-propose="submit" disabled={locked} type="submit">
        {busy ? 'Proposing…' : 'Propose'}
      </button>
      {busy || !same(pending) ? null : (
        <p className="card__sub" data-propose="unresolved">
          This may already have been proposed. Proposing again sends the same attempt, so the server
          answers with the original result rather than opening a second proposal.
        </p>
      )}
      {!closed ? null : (
        <p className="card__sub" data-propose="closed">
          The server refused this. The form is closed rather than asking again on your behalf.
        </p>
      )}
    </form>
  );
}

/** How many lineages are on the task, or that nobody has said. */
function countWord(proposals: readonly ProposalLineage[] | undefined): string {
  if (proposals === undefined) return 'not read';
  if (proposals.length === 0) return 'none';
  return `${String(proposals.length)} on this task`;
}

/** Minor units as money a person reads, with the currency the proposal named. */
function money(minor: number, currency: string): string {
  const amount = (minor / 100).toLocaleString('en-AU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === '' ? amount : `${currency} ${amount}`;
}

/** Dollars as the server's minor units, rounded rather than truncated. */
function minorOf(amount: string): number {
  return Math.round(Number(amount) * 100);
}

/**
 * A stored value, printed rather than interpreted.
 *
 * The evidence body and the proposal payload are whatever the renderer and the
 * proposer put there. A screen that walked them looking for fields it knew would
 * silently drop the ones it did not, and a decision made on a partial reading of
 * the evidence is the failure the gate exists to prevent.
 */
function stored(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
