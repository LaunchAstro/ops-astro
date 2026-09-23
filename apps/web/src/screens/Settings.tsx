// SPDX-License-Identifier: AGPL-3.0-only
//
// `/settings`: the two business settings the model classifies `operation`, read
// from the server, opened by the session's own capabilities, and written
// against the revision the read carried.
//
// **What these two settings are.** `four_eyes_threshold` decides who must agree
// before money moves and `client_sign_off_required` decides who must agree
// before work completes (`docs/local/AUTHORITY.md`). Both are classified
// `operation` rather than `generic` because a setting that changes who must
// agree is an authority change wearing configuration's clothes — so neither is
// reachable through a generic edit, and each has a named command of its own.
// This screen posts to those two commands and nowhere else.
//
// **The values are the server's now.** `settings.read` answers each row with
// the instant the server last wrote it, so the number beside a setting is the
// business's and not this browser's memory of its own last write. That memory
// is still kept and it is still written, but it is drawn in one case only: when
// the read is refused or the API has none, which is the case this screen used
// to be in permanently. Two numbers with two provenances on one page, one of
// them possibly stale, is exactly the ambiguity the read removes — so where the
// server answers, the browser's copy is not on the page at all.
//
// **The controls are opened by `session.capabilities`, not by asking.** Before
// that read, the first press of a control by somebody who may not use it was
// always a refused request. Now the grants are known and the controls follow
// them: `settings:manage` opens them, its absence closes them with the reason
// on the page, a *refused* capability read closes them too — a screen that
// cannot find out what somebody may do does not guess in their favour — and an
// *unavailable* one leaves them open, because nobody decided anything.
//
// The rules are in `settings/use-settings.ts` and the states this screen can be
// in are drawn by `settings/panels.tsx`. What is left here is the form.

import { useState, type ReactElement } from 'react';
import { Empty } from '@launchastro/ui';
import type { OperationsClient } from '../operations/client.ts';
import { CapabilityBanner, ConflictBlock, ReadBanner, ValueLine } from './settings/panels.tsx';
import { useSettings, type StorageLike, type Which } from './settings/use-settings.ts';

export type { StorageLike } from './settings/use-settings.ts';

export interface SettingsScreenProps {
  readonly client: OperationsClient;
  /** A read belongs to one reader of one business, and so does its projection. */
  readonly grantKey: string;
  /** `sessionStorage`, never `localStorage`: the same rule the session lives under. */
  readonly storage: StorageLike | null;
}

export function SettingsScreen(props: SettingsScreenProps): ReactElement {
  const businessKey = props.client.businessKey;
  const model = useSettings(props.client, props.grantKey, props.storage);

  // What is in the controls, which is what a person is proposing — never what
  // the business holds. The server's value is drawn beside them, from the read.
  const [threshold, setThreshold] = useState('');
  const [off, setOff] = useState(false);
  const [signOff, setSignOff] = useState(false);

  const saveFourEyes = (): void => {
    // Null is a real value and not an absence: the band is off, which is what
    // the accepted rule permits and what a zero would not mean.
    if (off) {
      model.save('four-eyes', null);
      return;
    }
    const value = Number(threshold);
    if (threshold.trim() === '' || !Number.isFinite(value)) {
      model.complain('Type a number of dollars, or turn the band off.');
      return;
    }
    model.save('four-eyes', value);
  };

  /** The fallback line: this browser's own last confirmed write, named as that. */
  const confirmedLine = (which: Which): ReactElement | null => {
    if (!model.fallback) return null;
    const held =
      which === 'four-eyes'
        ? model.confirmed.fourEyes === undefined
          ? 'not known'
          : model.confirmed.fourEyes === null
            ? 'off'
            : String(model.confirmed.fourEyes)
        : model.confirmed.signOff === undefined
          ? 'not known'
          : model.confirmed.signOff
            ? 'on'
            : 'off';
    return (
      <p className="card__sub" data-settings={`${which}-known`}>
        Last confirmed by this browser: {held}
      </p>
    );
  };

  const conflictFor = (which: Which): ReactElement | null =>
    model.conflict === null || model.conflict.which !== which ? null : (
      <ConflictBlock
        conflict={model.conflict}
        row={model.rowFor(which)}
        disabled={model.disabled}
        onWriteOver={model.writeOver}
      />
    );

  return (
    <div className="stack" data-screen="settings" data-business={businessKey}>
      <header className="tpr">
        <h2 className="tpr__title">Settings for {businessKey}</h2>
        <div className="card__sub">
          Two settings the model classifies <code>operation</code>: each changes who must agree
          before something happens, so each has a command of its own and neither is reachable
          through an ordinary edit.
        </div>
      </header>

      <ReadBanner state={model.read} />

      {/* The browser's own memory, in the two states where the server did not answer. */}
      {model.fallback ? (
        <p className="signin__ended" role="status" data-settings="not-readable">
          What is shown below is the last write this browser had confirmed by the server, not the
          value the business holds. It is what there is while <code>settings.read</code> is not
          answering.
        </p>
      ) : null}

      <CapabilityBanner state={model.capabilities} />

      {model.because === null ? null : (
        <p className="field__error" role="alert" data-settings="refusal">
          {model.because}
        </p>
      )}

      {model.closed ? (
        <div className="readstate" data-outcome="denied" data-settings="closed">
          <Empty
            title="You are not permitted to change these settings."
            description="The server refused the write. The controls are closed rather than asking again on your behalf."
            hint="A grant can be revoked between a capability read and a press, and the write is the newer answer."
          />
        </div>
      ) : null}

      <section className="sb__sect">
        <div className="sb__sh">
          <span className="sb__k">Four-eyes threshold</span>
        </div>
        <p className="card__sub">
          The amount above which a second person must agree before money moves. Off means one person
          is enough at any amount.
        </p>
        {model.answered ? <ValueLine which="four-eyes" row={model.rowFor('four-eyes')} /> : null}
        {confirmedLine('four-eyes')}
        {conflictFor('four-eyes')}
        <div className="field">
          <label className="tf__k" htmlFor="settings-four-eyes">
            Threshold
          </label>
          <input
            id="settings-four-eyes"
            className="input"
            type="number"
            min={0}
            step={1}
            disabled={model.disabled || off}
            value={threshold}
            onChange={(event) => {
              setThreshold(event.target.value);
            }}
          />
        </div>
        <div className="field">
          <label className="tf__k" htmlFor="settings-four-eyes-off">
            <input
              id="settings-four-eyes-off"
              type="checkbox"
              disabled={model.disabled}
              checked={off}
              onChange={(event) => {
                setOff(event.target.checked);
              }}
            />{' '}
            Turn the band off
          </label>
        </div>
        <button
          className="btn btn--primary"
          type="button"
          data-settings="save-four-eyes"
          disabled={model.disabled}
          onClick={saveFourEyes}
        >
          {model.busy === 'four-eyes' ? 'Saving…' : 'Save threshold'}
        </button>
      </section>

      <section className="sb__sect">
        <div className="sb__sh">
          <span className="sb__k">Client sign-off</span>
        </div>
        <p className="card__sub">
          Whether the client must agree before work is counted as complete.
        </p>
        {model.answered ? <ValueLine which="sign-off" row={model.rowFor('sign-off')} /> : null}
        {confirmedLine('sign-off')}
        {conflictFor('sign-off')}
        <div className="field">
          <label className="tf__k" htmlFor="settings-sign-off">
            <input
              id="settings-sign-off"
              type="checkbox"
              disabled={model.disabled}
              checked={signOff}
              onChange={(event) => {
                setSignOff(event.target.checked);
              }}
            />{' '}
            Require client sign-off
          </label>
        </div>
        <button
          className="btn btn--primary"
          type="button"
          data-settings="save-sign-off"
          disabled={model.disabled}
          onClick={() => {
            model.save('sign-off', signOff);
          }}
        >
          {model.busy === 'sign-off' ? 'Saving…' : 'Save sign-off'}
        </button>
      </section>
    </div>
  );
}
