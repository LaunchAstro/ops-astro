// SPDX-License-Identifier: AGPL-3.0-only
//
// The gate on the exact version (DA-05): what it pins, what approving unlocks,
// and its two controls. The box decides nothing: each control hands the gate
// and version the read showed to the caller.

import { useState, type ReactElement } from 'react';
import { CHANGE_ROUNDS, type GateBox, type RunStory } from '../../state/agent-run.ts';
import type { RunLineage } from '../../state/run-projection.ts';
import { money, shortDigest, words } from './format.ts';

export type GateDecision = 'approve' | 'request_changes' | 'escalate';

/** Who a gate past its rounds of changes may be escalated to (DA-07). */
export interface GatePerson {
  readonly personId: string;
  readonly name: string;
}

/** A decision on the exact gate; an escalation names the person it goes to. */
export type OnDecide = (gate: GateRef, decision: GateDecision, recipientPersonId?: string) => void;

/** The exact gate and version a control acts on. */
export interface GateRef {
  readonly gateId: string;
  readonly versionId: string;
}

type Shown = Exclude<GateBox, { readonly kind: 'none' }>;

function gateFact(key: string, value: ReactElement | string, name: string): ReactElement {
  return (
    <div className="sout__row" data-gate-fact={name}>
      <span className="tf__k">{key}</span>
      <span className="sb__state">{value}</span>
    </div>
  );
}

export function Gate(props: {
  readonly story: RunStory;
  readonly effect: string | null;
  readonly busy: boolean;
  /** A refused decision closed the controls; the box says so in their place. */
  readonly closed: boolean;
  readonly nameOf: (personId: string) => string;
  readonly decisions: RunLineage['decisions'];
  readonly people: readonly GatePerson[];
  readonly onDecide: OnDecide;
}): ReactElement | null {
  const box: GateBox = props.story.gate;
  if (box.kind === 'none') return null;
  const stale = box.kind === 'stale';
  return (
    <div
      className={stale ? 'gatebox gatebox--stale' : 'gatebox'}
      data-agent="gate"
      data-gate-kind={box.kind}
      data-gate-id={box.gateId}
    >
      <div className={stale ? 'gate' : 'gate gate--armed'}>
        <span className="gate__mark" aria-hidden="true" />
        <div>
          <div className="gate__word">{stale ? 'Gate stale' : 'Human approval gate'}</div>
          <p className="gate__say">
            {words(props.story.head.purpose)}, waiting on a person with the gate’s authority.
          </p>
        </div>
      </div>
      <GateFacts box={box} story={props.story} effect={props.effect} />
      <GateActs {...props} box={box} />
    </div>
  );
}

/** What the gate offers now: its two controls, or why there are none. */
function GateActs(props: Parameters<typeof Gate>[0] & { readonly box: Shown }): ReactElement {
  const { box } = props;
  const last = props.decisions.at(-1);
  return (
    <div className="gatebox__acts" data-agent="gate-actions">
      {box.kind === 'armed' && props.closed ? (
        <span className="sbact__meta" data-gate="closed">
          The server refused a decision of yours on this task, so these controls are closed rather
          than asking again on your behalf.
        </span>
      ) : box.kind === 'armed' ? (
        <GateControls box={box} busy={props.busy} people={props.people} onDecide={props.onDecide} />
      ) : box.kind === 'stale' ? (
        <span className="sbact__meta" data-gate="stale">
          A stale gate cannot be approved. The run has to raise it again against the current
          version.
        </span>
      ) : last === undefined ? null : (
        <span className="sbact__meta" data-gate="decided">
          {words(last.decision)} by {props.nameOf(last.decidedByPersonId)} at {last.decidedAt}
        </span>
      )}
    </div>
  );
}

function GateFacts(props: {
  readonly box: Shown;
  readonly story: RunStory;
  readonly effect: string | null;
}): ReactElement {
  const { box } = props;
  const { head } = props.story;
  return (
    <div className="sout__box">
      {gateFact(
        'Exact artefact',
        <>
          v{box.version}{' '}
          <span className="sbact__meta u-mono" title={box.digest} data-gate="digest">
            {shortDigest(box.digest)}
          </span>
        </>,
        'artefact',
      )}
      {gateFact(
        'Approval unlocks',
        props.effect ?? `The run continues, within ${money(head.maximumMinor, head.currency)}.`,
        'unlocks',
      )}
      {box.kind === 'armed'
        ? gateFact('Why it waits', 'Nothing runs until a person decides this version.', 'waits')
        : null}
      {box.kind === 'stale'
        ? gateFact(
            'Invalidated',
            box.invalidatedBy ?? 'It no longer matches the run.',
            'invalidated',
          )
        : null}
    </div>
  );
}

function GateControls(props: {
  readonly box: Shown;
  readonly busy: boolean;
  readonly people: readonly GatePerson[];
  readonly onDecide: OnDecide;
}): ReactElement {
  const { box } = props;
  const gate = { gateId: box.gateId, versionId: box.versionId };
  return (
    <>
      {/* Two formal rounds of changes (DA-07); past them, escalate takes the place. */}
      {box.round > CHANGE_ROUNDS ? (
        <Escalate gate={gate} busy={props.busy} people={props.people} onDecide={props.onDecide} />
      ) : (
        <button
          className="btn btn--sm btn--secondary"
          type="button"
          data-gate-action="request_changes"
          disabled={props.busy}
          onClick={() => {
            props.onDecide(gate, 'request_changes');
          }}
        >
          Request changes
        </button>
      )}
      <button
        className="btn btn--sm btn--primary"
        type="button"
        data-gate-action="approve"
        disabled={props.busy}
        onClick={() => {
          props.onDecide(gate, 'approve');
        }}
      >
        Approve exact v{box.version}
      </button>
    </>
  );
}

/** Escalate at the bound: to the person chosen, nothing until one is. */
function Escalate(props: {
  readonly gate: GateRef;
  readonly busy: boolean;
  readonly people: readonly GatePerson[];
  readonly onDecide: OnDecide;
}): ReactElement {
  const [recipient, setRecipient] = useState('');
  return (
    <>
      <select
        aria-label="Escalate to"
        data-gate-escalate="recipient"
        disabled={props.busy}
        value={recipient}
        onChange={(event) => {
          setRecipient(event.target.value);
        }}
      >
        <option value="">Choose who decides it</option>
        {props.people.map((person) => (
          <option key={person.personId} value={person.personId}>
            {person.name}
          </option>
        ))}
      </select>
      <button
        className="btn btn--sm btn--secondary"
        type="button"
        data-gate-action="escalate"
        disabled={props.busy || recipient === ''}
        onClick={() => {
          if (recipient !== '') props.onDecide(props.gate, 'escalate', recipient);
        }}
      >
        Escalate
      </button>
    </>
  );
}
