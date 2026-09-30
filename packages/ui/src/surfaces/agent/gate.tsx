// SPDX-License-Identifier: AGPL-3.0-only
//
// The gate on the exact version (DA-05): what it pins, what approving unlocks,
// and its two controls. The box decides nothing: each control hands the gate
// and version the read showed to the caller.

import type { ReactElement } from 'react';
import { CHANGE_ROUNDS, type GateBox, type RunStory } from '../../state/agent-run.ts';
import type { RunLineage } from '../../state/run-projection.ts';
import { money, shortDigest, words } from './format.ts';

export type GateDecision = 'approve' | 'request_changes';

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
  readonly nameOf: (personId: string) => string;
  readonly decisions: RunLineage['decisions'];
  readonly onDecide: (gate: GateRef, decision: GateDecision) => void;
}): ReactElement | null {
  const box: GateBox = props.story.gate;
  if (box.kind === 'none') return null;
  const stale = box.kind === 'stale';
  const last = props.decisions.at(-1);
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
      <div className="gatebox__acts" data-agent="gate-actions">
        {box.kind === 'armed' ? (
          <GateControls box={box} busy={props.busy} onDecide={props.onDecide} />
        ) : stale ? (
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
  readonly onDecide: (gate: GateRef, decision: GateDecision) => void;
}): ReactElement {
  const { box } = props;
  const gate = { gateId: box.gateId, versionId: box.versionId };
  return (
    <>
      {box.round >= CHANGE_ROUNDS ? (
        <button
          className="btn btn--sm btn--secondary"
          type="button"
          disabled
          data-gate-action="escalate"
        >
          Escalate
        </button>
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
