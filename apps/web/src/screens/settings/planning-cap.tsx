// SPDX-License-Identifier: AGPL-3.0-only
//
// The AI planning chat's budget (AW-04; owner, NATHAN-STAGE1-TODAY 4): the
// business's planning cap, AUD 50 until somebody moves it. `settings.read`
// carries it beside the settings; `budget.set_planning_cap` moves it, asked
// `decide` on `billing` for the whole business, so the control opens for a
// session holding that and stays closed, with the reason, for everyone else.
//
// **Against the limit the page read.** The command takes the limit the caller
// last saw, never a revision: a cap somebody else moved first is refused
// `VERSION_STALE`, the page rereads and shows the new limit with the server's
// words, and the next press is against that. Nothing is sent again unasked.

import { useState, type ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import type { ReadState } from '../../data/authorised-read.ts';
import { useCommand } from '../../records/use-command.ts';
import type {
  CapabilitiesResult,
  SettingsReadResult,
} from '../../../../../packages/core-wire/src/index.ts';
import { rowsInHand } from './reads.ts';

/** Dollars and cents as a person types them: a whole number, or up to two places. */
const DOLLARS = /^\d+(?:\.\d{1,2})?$/u;

const inDollars = (minor: number, currency: string): string =>
  `${currency} ${(minor / 100).toFixed(2)}`;

/** The minor units a typed amount names, or null when it is not whole cents above zero. */
export function minorOf(typed: string): number | null {
  const text = typed.trim();
  if (!DOLLARS.test(text)) return null;
  const [whole = '0', cents = ''] = text.split('.');
  const minor = Number(whole) * 100 + Number(cents.padEnd(2, '0'));
  return Number.isSafeInteger(minor) && minor >= 1 ? minor : null;
}

const holdsBillingDecide = (caps: ReadState<CapabilitiesResult>): boolean =>
  caps.outcome === 'unavailable'
    ? true
    : caps.outcome === 'ready' || caps.outcome === 'empty'
      ? caps.value.grants.some((g) => g.collection === 'billing' && g.action === 'decide')
      : false;

export interface PlanningCapProps {
  readonly client: OperationsClient;
  readonly read: ReadState<SettingsReadResult>;
  readonly capabilities: ReadState<CapabilitiesResult>;
  readonly reload: () => void;
}

/** What the budget is, whether this session may move it, and the last answer's words. */
function CapNotes(props: {
  readonly cap: SettingsReadResult['planningCap'] | null;
  readonly may: boolean;
  readonly because: string | null;
}): ReactElement {
  const { cap, may, because } = props;
  return (
    <>
      <div className="sb__sh">
        <span className="sb__k">AI planning budget</span>
      </div>
      <p className="card__sub">
        What the agent&apos;s planning chat may spend for this business before a plan is accepted. A
        reply that would go past it is refused.
      </p>
      {cap === null ? null : (
        <p className="card__sub" data-settings="planning-cap-known">
          Now: {inDollars(cap.limitMinor, cap.currency)}
          {cap.set ? '' : ' (the default for every business)'}
        </p>
      )}
      {may ? null : (
        <p className="card__sub" data-settings="planning-cap-closed">
          Only an owner or an administrator (billing decide) changes the planning budget.
        </p>
      )}
      {because === null ? null : (
        <p className="field__error" role="alert" data-settings="planning-cap-refusal">
          {because}
        </p>
      )}
    </>
  );
}

/** The amount a person types and the press that sends it. */
function CapForm(props: {
  readonly typed: string;
  readonly onType: (typed: string) => void;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly onSave: () => void;
}): ReactElement {
  return (
    <>
      <div className="field">
        <label className="tf__k" htmlFor="settings-planning-cap">
          Budget in dollars
        </label>
        <input
          id="settings-planning-cap"
          className="input"
          type="text"
          inputMode="decimal"
          disabled={props.disabled}
          value={props.typed}
          onChange={(event) => {
            props.onType(event.target.value);
          }}
        />
      </div>
      <button
        className="btn btn--primary"
        type="button"
        data-settings="save-planning-cap"
        disabled={props.disabled}
        onClick={props.onSave}
      >
        {props.busy ? 'Saving…' : 'Save budget'}
      </button>
    </>
  );
}

export function PlanningCapSection(props: PlanningCapProps): ReactElement {
  const cap = rowsInHand(props.read)?.planningCap ?? null;
  const command = useCommand();
  const [typed, setTyped] = useState('');
  const [complaint, setComplaint] = useState<string | null>(null);
  const may = holdsBillingDecide(props.capabilities);
  const disabled = !may || command.locked || cap === null;
  const because = complaint ?? command.because;

  const save = (): void => {
    if (disabled) return;
    const limitMinor = minorOf(typed);
    if (limitMinor === null) {
      setComplaint('Type an amount in dollars above zero, to the cent at most.');
      return;
    }
    setComplaint(null);
    command.run(
      () =>
        props.client.mutate('budget.set_planning_cap', {
          limitMinor,
          currency: cap.currency,
          fromLimitMinor: cap.limitMinor,
        }),
      () => {
        props.reload();
      },
    );
  };

  return (
    <section className="sb__sect" data-settings="planning-cap">
      <CapNotes cap={cap} may={may} because={because} />
      <CapForm
        typed={typed}
        onType={setTyped}
        disabled={disabled}
        busy={command.busy}
        onSave={save}
      />
    </section>
  );
}
