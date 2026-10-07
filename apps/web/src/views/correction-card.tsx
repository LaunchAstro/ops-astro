// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 (P30): the sidebar's correction desks and card, drawn above the
// drawer's transcript beside its allowance line.
//
// The door asks for a one-word change through the host's port and says a
// refusal in plain words. Each card says what was asked and where it stands,
// as `live_correction.read` last answered. It publishes nothing: its only
// controls are a person's approve and decline, through
// `live_correction.decide`, on a correction still waiting for one. A publish
// follows that decision on the server, never a press here. Every value is
// drawn as text.

import { useState, type FormEvent, type ReactElement } from 'react';
import { STATE_WORDS, type CorrectionAsk, type ProposePort } from '../assistant/correction.ts';
import {
  desksOf,
  requestPort,
  type Correction,
  type Locate,
} from '../assistant/correction-desks.ts';
import { useCorrections, type Corrections } from '../assistant/use-corrections.ts';
import type { OperationsClient } from '../operations/client.ts';

const DECISIONS = [
  ['approve', 'Approve'],
  ['reject', 'Decline'],
] as const;

/** A person's approve and decline, the card's only controls. */
function Decisions(props: {
  readonly busy: boolean;
  readonly onDecide: (decision: 'approve' | 'reject') => void;
}): ReactElement {
  return (
    <div className="aip__plan-act">
      {DECISIONS.map(([decision, words]) => (
        <button
          key={decision}
          type="button"
          className={decision === 'approve' ? 'btn btn--primary btn--sm' : 'btn btn--sm'}
          data-correction-decide={decision}
          disabled={props.busy}
          onClick={() => {
            props.onDecide(decision);
          }}
        >
          {words}
        </button>
      ))}
    </div>
  );
}

export function CorrectionCard(props: {
  readonly correction: Correction;
  readonly busy: boolean;
  readonly onDecide: (decision: 'approve' | 'reject') => void;
}): ReactElement {
  const { correction, busy, onDecide } = props;
  const { ask } = correction;
  const decidable = correction.state === 'requested' && correction.versionId !== null;
  return (
    <section
      className="aip__plan"
      data-correction-card=""
      data-correction-state={correction.state}
      aria-label={`One-word change on the ${ask.page} page`}
    >
      <span className="aip__plan-k">One-word change</span>
      <p className="aip__plan-words">
        {`${ask.page} page: “${ask.word}” becomes “${ask.replacement}”.`}
      </p>
      <p className="aip__plan-meta" data-correction-words="">
        {STATE_WORDS[correction.state]}
        {correction.approver === null ? '' : ` Decided by ${correction.approver}.`}
      </p>
      {correction.refusal === null ? null : (
        <p className="aip__plan-meta aip__plan-refused" role="alert">
          {correction.refusal}
        </p>
      )}
      {decidable ? <Decisions busy={busy} onDecide={onDecide} /> : null}
    </section>
  );
}

const FIELDS = [
  ['page', 'Page'],
  ['word', 'Word'],
  ['replacement', 'Becomes'],
] as const;

const BLANK: CorrectionAsk = { page: '', word: '', replacement: '' };

function Door(props: { readonly corrections: Corrections }): ReactElement {
  const { corrections } = props;
  const [ask, setAsk] = useState<CorrectionAsk>(BLANK);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    corrections.request(ask);
  };
  return (
    <form className="aip__plan" data-correction-door="" onSubmit={submit}>
      <span className="aip__plan-k">Ask for a one-word change</span>
      {FIELDS.map(([name, label]) => (
        <div className="field" key={name}>
          <label className="field__label" htmlFor={`correction-${name}`}>
            {label}
          </label>
          <input
            id={`correction-${name}`}
            className="tf"
            name={name}
            value={ask[name]}
            onChange={(event) => {
              setAsk({ ...ask, [name]: event.target.value });
            }}
          />
        </div>
      ))}
      {corrections.refusal === null ? null : (
        <p className="field__error" role="alert" data-correction-refusal="">
          {corrections.refusal}
        </p>
      )}
      <div className="aip__plan-act">
        <button
          type="submit"
          className="btn btn--primary btn--sm"
          data-correction-ask=""
          disabled={corrections.busy}
        >
          Ask for this change
        </button>
      </div>
    </form>
  );
}

/** The door and the active business's desks. */
export function SidebarCorrections(props: {
  readonly client: OperationsClient;
  readonly propose: ProposePort;
}): ReactElement {
  const corrections = useCorrections(props.client, props.propose);
  return (
    <div data-assistant="corrections">
      <Door corrections={corrections} />
      {desksOf(corrections.list).map((desk) => (
        <section key={desk.key} data-correction-desk={desk.key} aria-label={desk.title}>
          <span className="aip__plan-k">{desk.title}</span>
          {desk.corrections.map((correction) => (
            <CorrectionCard
              key={correction.correctionId}
              correction={correction}
              busy={corrections.busy}
              onDecide={(decision) => {
                corrections.decide(correction.correctionId, decision);
              }}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

/** What the agent sidebar's host hands in for corrections (`assistant.tsx`). */
export interface CorrectionHost {
  /** The site read that finds a correction's file (`Locate`); without it no door is drawn. */
  readonly locate?: Locate;
}

/** The allowance line, and the correction door and desks where the host hands in the site read. */
export const besideAllowance = (
  allowance: ReactElement,
  host: CorrectionHost & { readonly client: OperationsClient },
): ReactElement => (
  <>
    {allowance}
    {host.locate === undefined ? null : (
      <SidebarCorrections client={host.client} propose={requestPort(host.client, host.locate)} />
    )}
  </>
);
