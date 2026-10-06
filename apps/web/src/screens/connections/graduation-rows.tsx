// SPDX-License-Identifier: AGPL-3.0-only
//
// Section 010's rows (MP-14-10a): one graduation row per action class for the
// chosen client, and one card per standing approval or refusal.
//
// Every row carries the same switch, including the rows that can never move:
// a disabled switch with its reason beside it answers "why not" where a
// missing control only raises it. The record is three counts, never a score.
// A refusal is drawn differently from an approval, because reading one as
// the other is the expensive mistake.

import type { ReactElement } from 'react';
import type {
  GraduationRowView,
  MandateView,
} from '../../../../../packages/core-wire/src/index.ts';
import { PromoteForm, type Filing } from './graduation-forms.tsx';

type State = GraduationRowView['state'];

const WORD: Readonly<Record<State, string>> = {
  promoted: 'Running unattended',
  ready: 'Clears the bar',
  held: 'Held by a sentence',
  short: 'Not enough record',
  mixed: 'Record argues against',
  never: 'Never unattended',
  none: 'No record at all',
};
const TONE: Readonly<Record<State, string>> = {
  promoted: 'is-ok',
  ready: 'is-ok',
  held: 'is-warn',
  short: 'is-idle',
  mixed: 'is-bad',
  never: 'is-idle',
  none: 'is-idle',
};

/** Why the switch is dead, in the fewest words that are still true. */
function why(row: GraduationRowView): string {
  switch (row.state) {
    case 'held':
      return `Held by ${row.heldBy ?? 'a sentence'} below`;
    case 'short':
      return `${row.approved} approved so far`;
    case 'mixed':
      return `${row.rejected} rejected`;
    case 'never':
      return row.neverWhy === 'audience' ? 'The client reads it' : `Ceiling: ${row.clearance}`;
    case 'none':
      return 'Never proposed here';
    default:
      return '';
  }
}

const money = (ceiling: NonNullable<MandateView['ceiling']>): string =>
  new Intl.NumberFormat('en-AU', { style: 'currency', currency: ceiling.currency }).format(
    ceiling.amountMinor / 100,
  );

function GraduationSwitch(props: {
  readonly row: GraduationRowView;
  readonly clientLabel: string;
  readonly flip: () => void;
}): ReactElement {
  const { row } = props;
  const on = row.state === 'promoted';
  const live = on || row.state === 'ready';
  let said = why(row);
  if (on) said = `Auto since ${row.promotedAt?.slice(0, 10) ?? ''}`;
  else if (live) said = 'Promote to auto';
  return (
    <div className="grad__act">
      <button
        type="button"
        className="autosw"
        role="switch"
        aria-checked={on}
        disabled={!live}
        aria-disabled={!live}
        aria-label={`Run ${row.classLabel} unattended for ${props.clientLabel}`}
        onClick={props.flip}
        data-auto
      >
        <span className="autosw__k" />
      </button>
      <span className="autosw__lbl" data-grad-why={live ? undefined : ''}>
        {said}
      </span>
    </div>
  );
}

function GraduationRecord(props: { readonly row: GraduationRowView }): ReactElement {
  const { row } = props;
  if (row.since === null) {
    return (
      <div className="grad__rec">
        <span className="muted t-xs">No decisions on record.</span>
      </div>
    );
  }
  return (
    <div className="grad__rec">
      <span className="grad__n">
        <b>{row.approved}</b> approved
      </span>
      <span className="grad__n">
        <b>{row.edited}</b> edited
      </span>
      <span className="grad__n">
        <b>{row.rejected}</b> rejected
      </span>
      <span className="muted t-xs">since {row.since}</span>
    </div>
  );
}

export function GraduationRow(props: {
  readonly row: GraduationRowView;
  readonly clientLabel: string;
  readonly promoting: boolean;
  readonly flip: () => void;
  readonly promote: (filing: Filing) => void;
  readonly cancel: () => void;
}): ReactElement {
  const { row } = props;
  return (
    <div className="grad__row" data-grad={row.id}>
      <div className="grad__head">
        <div className="grad__name">
          <b>{row.classLabel}</b>
          <span className="grad__type">{row.actionClass}</span>
        </div>
        {/* The clearance explainer documents are not built (MP-7-6). */}
        <span className="chip chip--outline" aria-disabled="true">
          {row.clearance}
        </span>
        <span className={`chip chip--outline ${TONE[row.state]}`} data-grad-state>
          {WORD[row.state]}
        </span>
      </div>
      <GraduationSwitch row={row} clientLabel={props.clientLabel} flip={props.flip} />
      {props.promoting ? (
        <PromoteForm
          id={row.id}
          label={row.classLabel}
          promote={props.promote}
          cancel={props.cancel}
        />
      ) : null}
      <GraduationRecord row={row} />
      {row.note === '' ? null : <p className="grad__note">{row.note}</p>}
    </div>
  );
}

export function Mandate(props: {
  readonly mandate: MandateView;
  readonly revoke: () => void;
}): ReactElement {
  const { mandate } = props;
  const meta = [
    mandate.id.slice(0, 8),
    mandate.classes.map((one) => (one === '*' ? 'all classes' : one)).join(', '),
    mandate.ceiling === null ? null : `up to ${money(mandate.ceiling)}`,
    `${mandate.expired ? 'expired' : 'until'} ${mandate.expiresAt.slice(0, 10)}`,
    `by ${mandate.authoredBy.slice(0, 8)}`,
    mandate.refuses ? 'refusal' : null,
  ].filter((part) => part !== null);
  return (
    <div className={`ps${mandate.refuses ? ' ps--no' : ''}`} data-mandate={mandate.id}>
      <div className="ps__body">
        <p className="ps__text">{mandate.label}</p>
        <div className="ps__meta u-mono">{meta.join(' · ')}</div>
      </div>
      <button
        type="button"
        className="ps__x"
        aria-label={`Revoke ${mandate.label}`}
        onClick={props.revoke}
        data-mandate-revoke
      >
        ×
      </button>
    </div>
  );
}
