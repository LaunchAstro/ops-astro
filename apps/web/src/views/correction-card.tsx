// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 (P30): the sidebar's correction desks and card, drawn above the
// drawer's transcript beside its allowance line.
//
// The door asks for a one-word change through the host's port and says a
// refusal in plain words; without the host's site read there is no door, but
// the desks are still drawn from the business's list. Each card says what was
// asked and where it stands, as `live_correction.read` last answered. It
// publishes nothing itself: its decision controls are a person's Launch and
// Decline, through `live_correction.decide` (Launch sends `approve`), on a
// correction still waiting for one. A publish follows that decision on the
// server, never a press here. A published or reverted card opens its
// receipts. Every value is drawn as text.

import { useState, type FormEvent, type ReactElement } from 'react';
import type { CorrectionReceiptView } from '../../../../packages/core-wire/src/index.ts';
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
  // The owner's word for this flow (#1612); the server's decision stays `approve`.
  ['approve', 'Launch'],
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

const capture = (label: string, taken: CorrectionReceiptView['afterCapture']): ReactElement =>
  taken === null ? (
    <p className="aip__plan-meta">{`${label}: not captured.`}</p>
  ) : (
    <div>
      <span className="aip__plan-meta">{taken.clipped ? `${label} (cut short)` : label}</span>
      <p className="aip__plan-words">{taken.text}</p>
    </div>
  );

/** A published or reverted card's receipts, read when a person opens them. */
function Receipts(props: {
  readonly receipts: readonly CorrectionReceiptView[] | null;
  readonly busy: boolean;
  readonly onOpen: () => void;
}): ReactElement {
  if (props.receipts === null) {
    return (
      <div className="aip__plan-act">
        <button
          type="button"
          className="btn btn--sm"
          data-correction-receipts-open=""
          disabled={props.busy}
          onClick={props.onOpen}
        >
          Receipts
        </button>
      </div>
    );
  }
  return (
    <div data-correction-receipts="">
      {props.receipts.length === 0 ? (
        <p className="aip__plan-meta">No receipt is recorded yet.</p>
      ) : null}
      {props.receipts.map((receipt) => (
        <section key={receipt.receiptId} className="aip__plan-done">
          <p className="aip__plan-meta">
            {`${receipt.step === 'publish' ? 'Publish' : 'Revert'}: ${receipt.outcome}, ${receipt.recordedAt}.`}
          </p>
          <p className="aip__plan-meta">{`Commit ${receipt.commit ?? 'not recorded'}.`}</p>
          <p className="aip__plan-meta">{`Deployment ${receipt.deploymentId ?? 'not recorded'}.`}</p>
          {capture('Before', receipt.beforeCapture)}
          {capture('After', receipt.afterCapture)}
        </section>
      ))}
    </div>
  );
}

export function CorrectionCard(props: {
  readonly correction: Correction;
  readonly busy: boolean;
  readonly onDecide: (decision: 'approve' | 'reject') => void;
  readonly onReceipts: () => void;
}): ReactElement {
  const { correction, busy, onDecide } = props;
  const { ask } = correction;
  const decidable = correction.state === 'requested' && correction.versionId !== null;
  const receipted = correction.state === 'published' || correction.state === 'reverted';
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
      {receipted ? (
        <Receipts receipts={correction.receipts} busy={busy} onOpen={props.onReceipts} />
      ) : null}
    </section>
  );
}

const FIELDS = [
  ['page', 'Page'],
  ['word', 'Word'],
  ['replacement', 'Becomes'],
] as const;

const BLANK: CorrectionAsk = { page: '', word: '', replacement: '' };

function Door(props: {
  readonly corrections: Corrections;
  readonly request: (ask: CorrectionAsk) => void;
}): ReactElement {
  const { corrections } = props;
  const [ask, setAsk] = useState<CorrectionAsk>(BLANK);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    props.request(ask);
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

/** The door, where there is a port, and the active business's desks, under the session's grant. */
export function SidebarCorrections(props: {
  readonly client: OperationsClient;
  readonly propose?: ProposePort | undefined;
  /** The grant it serves (`grantKeyOf`): its desks are held under it as well as the business. */
  readonly grantKey?: string | undefined;
}): ReactElement {
  const corrections = useCorrections(props.client, props.propose, props.grantKey);
  const { request } = corrections;
  return (
    <div data-assistant="corrections">
      {/* A draft is its grant's: a change of business, person or session starts a blank door. */}
      {request === undefined ? null : (
        <Door
          key={`${props.client.businessKey}|${props.grantKey ?? ''}`}
          corrections={corrections}
          request={request}
        />
      )}
      {corrections.listRefusal === null ? null : (
        <p className="aip__plan-meta aip__plan-refused" data-correction-list-refusal="">
          {corrections.listRefusal}
        </p>
      )}
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
              onReceipts={() => {
                corrections.openReceipts(correction.correctionId);
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

/** The allowance line, the correction desks, and the door where the host hands in the site read. */
export const besideAllowance = (
  allowance: ReactElement,
  host: CorrectionHost & {
    readonly client: OperationsClient;
    readonly grantKey?: string | undefined;
  },
): ReactElement => (
  <>
    {allowance}
    <SidebarCorrections
      client={host.client}
      grantKey={host.grantKey}
      propose={host.locate === undefined ? undefined : requestPort(host.client, host.locate)}
    />
  </>
);
