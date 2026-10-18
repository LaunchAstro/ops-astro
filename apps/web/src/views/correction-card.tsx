// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 (P30): the sidebar's correction desks and card, drawn above the
// drawer's transcript beside its allowance line.
//
// The door asks for a one-word change on the host's task and says a refusal
// in plain words. Each card says what was asked and where it stands, as
// `live_correction.read` last answered. It publishes nothing: its only
// controls are a person's approve and decline, through
// `live_correction.decide`, on a correction still waiting for one. Approve is
// drawn only while the version's check holds (`use-launch-clock.ts`). A
// publish follows that decision on the server, never a press here. Every
// value is drawn as text.

import { useState, type FormEvent, type ReactElement } from 'react';
import { stateWords, type CorrectionAsk, type ProposePort } from '../assistant/correction.ts';
import { desksOf, type Correction } from '../assistant/correction-desks.ts';
import { taskCorrectionPort } from '../assistant/locate.ts';
import { useCorrections, type Corrections } from '../assistant/use-corrections.ts';
import { useLaunchClock } from '../assistant/use-launch-clock.ts';
import type { OperationsClient } from '../operations/client.ts';

const DECISIONS = [
  ['approve', 'Approve'],
  ['reject', 'Decline'],
] as const;

/** A person's approve and decline, the card's only controls; approve only while the check holds. */
function Decisions(props: {
  readonly busy: boolean;
  readonly launchable: boolean;
  readonly onDecide: (decision: 'approve' | 'reject') => void;
}): ReactElement {
  const offered = DECISIONS.filter(([decision]) => decision !== 'approve' || props.launchable);
  return (
    <div className="aip__plan-act">
      {offered.map(([decision, words]) => (
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
  /** Read the correction again: the card's clock calls it. */
  readonly onReread: () => void;
}): ReactElement {
  const { correction, busy, onDecide } = props;
  const { ask } = correction;
  const { launchable, checking } = useLaunchClock(correction, props.onReread);
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
        {stateWords(correction.state, correction.reason)}
        {correction.approver === null ? '' : ` Decided by ${correction.approver}.`}
      </p>
      {checking ? (
        <p className="aip__plan-meta" data-correction-checking="">
          Checking the page again…
        </p>
      ) : null}
      {correction.refusal === null ? null : (
        <p className="aip__plan-meta aip__plan-refused" role="alert">
          {correction.refusal}
        </p>
      )}
      {decidable ? <Decisions busy={busy} launchable={launchable} onDecide={onDecide} /> : null}
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

/** The door and the active business's desks, under the session's grant. */
export function SidebarCorrections(props: {
  readonly client: OperationsClient;
  readonly propose: ProposePort;
  /** The grant it serves (`grantKeyOf`): its desks are held under it as well as the business. */
  readonly grantKey?: string | undefined;
}): ReactElement {
  const corrections = useCorrections(props.client, props.propose, props.grantKey);
  return (
    <div data-assistant="corrections">
      {/* A draft is its grant's: a change of business, person or session starts a blank door. */}
      <Door key={`${props.client.businessKey}|${props.grantKey ?? ''}`} corrections={corrections} />
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
              onReread={() => {
                corrections.reread(correction.correctionId);
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
  /** The task a correction is asked on; without one no door is drawn. */
  readonly taskId?: string | undefined;
}

/** The allowance line, and the correction door and desks where the host hands in a task. */
export const besideAllowance = (
  allowance: ReactElement,
  host: CorrectionHost & {
    readonly client: OperationsClient;
    readonly grantKey?: string | undefined;
  },
): ReactElement => (
  <>
    {allowance}
    {host.taskId === undefined ? null : (
      <SidebarCorrections
        client={host.client}
        grantKey={host.grantKey}
        propose={taskCorrectionPort(host.client, host.taskId)}
      />
    )}
  </>
);
