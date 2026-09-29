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

import type { ReactElement } from 'react';
import { PaneEmpty } from '@launchastro/ui';
import type { OperationsClient } from '../operations/client.ts';
import type {
  ProposalVersionView as ProposalVersion,
  ProposalView as ProposalLineage,
  TaskEnvelope,
} from '../../../../packages/core-wire/src/index.ts';
import { useCommand, type Settlement } from '../records/use-command.ts';
import { Chain, money, Reservations, stored } from './proposal-record.tsx';
import { Propose, TopUp, type ProposeDraft } from './propose-form.tsx';

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
  /** The task's open envelope, or null when the read carried none (T2e). */
  readonly envelope: TaskEnvelope | null;
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
  /** The task cap's currency, which the propose form offers and nothing else. */
  readonly capCurrency: string | null | undefined;
}

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

      {props.envelope === null ? null : (
        <TopUp
          client={props.client}
          envelope={props.envelope}
          onChanged={props.onChanged}
          recordId={props.recordId}
        />
      )}

      <Propose
        capCurrency={props.capCurrency}
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

/** How many lineages are on the task, or that nobody has said. */
function countWord(proposals: readonly ProposalLineage[] | undefined): string {
  if (proposals === undefined) return 'not read';
  if (proposals.length === 0) return 'none';
  return `${String(proposals.length)} on this task`;
}
