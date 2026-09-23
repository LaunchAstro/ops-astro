// SPDX-License-Identifier: AGPL-3.0-only
//
// `/settings`: the two business settings the model classifies `operation`, and
// the honest shape of a screen whose values the API will not read back.
//
// **What these two settings are.** `four_eyes_threshold` decides who must agree
// before money moves and `client_sign_off_required` decides who must agree
// before work completes (`docs/local/AUTHORITY.md`). Both are classified
// `operation` rather than `generic` because a setting that changes who must
// agree is an authority change wearing configuration's clothes — so neither is
// reachable through a generic edit, and each has a named command of its own.
// This screen posts to those two commands and nowhere else.
//
// **There is no settings read, and this screen says so.** `COMMAND_SURFACE`
// declares four reads — `task.read`, `task.board`, `person.list` and
// `preset.plan` — and none of them carries `business_settings`. The row exists,
// the writes work, and nothing in the API will tell a caller what the value
// currently is. So the screen opens on *unknown*, names the read that is
// missing, and draws the last write this browser had confirmed by the server's
// own `detail` echo, labelled as exactly that.
//
// Opening on the shipped default instead — `500`, `false` — would be this
// screen telling a person their business's threshold having never asked
// anybody, and they would have no way to tell that number from a real one. An
// unknown value drawn as unknown is the only version of this screen that is
// not quietly making things up.
//
// **The confirmed value is the server's word, not the typed one.** What lands
// in the box after a save is `detail.value` as the command returned it, so a
// value the server coerced or clamped is the one on the screen.
//
// **An authority refusal closes the controls.** There is no grant read either,
// so this screen cannot know whether a person holds `manage` on settings before
// it asks. It asks once, quotes the server's own code, and then stops offering
// controls that have already been refused for this reader.

import { useState, type ReactElement } from 'react';
import { Empty } from '@launchastro/ui';
import {
  isRefusal,
  type CallResult,
  type CommandOutcome,
  type OperationsClient,
} from '../operations/client.ts';
import { describeFailure } from '../records/submit.ts';

/** The narrow part of `Storage` this screen uses, so a test can hand it one. */
export interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface SettingsScreenProps {
  readonly client: OperationsClient;
  /** A confirmed value belongs to one reader of one business, as a read does. */
  readonly grantKey: string;
  /** `sessionStorage`, never `localStorage`: the same rule the session lives under. */
  readonly storage: StorageLike | null;
}

/** What the last confirmed write left behind, per business. */
interface Confirmed {
  readonly fourEyes?: number | null;
  readonly signOff?: boolean;
}

const keyFor = (businessKey: string): string => `ops-astro.settings.${businessKey}`;

function readConfirmed(storage: StorageLike | null, businessKey: string): Confirmed {
  // A storage that throws — private mode, blocked site data — must leave the
  // screen drawing "not known", which is the truth in that tab anyway.
  try {
    const raw = storage?.getItem(keyFor(businessKey)) ?? null;
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Confirmed) : {};
  } catch {
    return {};
  }
}

function writeConfirmed(storage: StorageLike | null, businessKey: string, next: Confirmed): void {
  try {
    storage?.setItem(keyFor(businessKey), JSON.stringify(next));
  } catch {
    /* Nothing to do. The screen still draws what it has in hand this render. */
  }
}

/** The server's own echo of the row it wrote, or nothing when it said nothing. */
function echoed(result: CallResult<CommandOutcome>): unknown {
  if (!('ok' in result)) return undefined;
  return result.value.detail?.['value'];
}

export function SettingsScreen(props: SettingsScreenProps): ReactElement {
  const businessKey = props.client.businessKey;
  const [confirmed, setConfirmed] = useState<Confirmed>(() =>
    readConfirmed(props.storage, businessKey),
  );
  const [because, setBecause] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const [busy, setBusy] = useState<'four-eyes' | 'sign-off' | null>(null);

  // What is in the controls, which is what a person is proposing — never what
  // the business holds, because this build cannot find that out.
  const [threshold, setThreshold] = useState('');
  const [off, setOff] = useState(false);
  const [signOff, setSignOff] = useState(false);

  const settle = (
    which: 'four-eyes' | 'sign-off',
    result: CallResult<CommandOutcome>,
    keep: (value: unknown) => Confirmed | null,
  ): void => {
    setBusy(null);
    const failure = describeFailure(result);
    if (failure !== null) {
      setBecause(failure);
      // Only an authority refusal closes the screen. A value the server would
      // not take is something the person can correct and send again.
      if (isRefusal(result) && result.code === 'SCOPE_NOT_GRANTED') setClosed(true);
      return;
    }
    setBecause(null);
    const next = keep(echoed(result));
    if (next === null) return;
    const merged = { ...confirmed, ...next };
    setConfirmed(merged);
    writeConfirmed(props.storage, businessKey, merged);
    void which;
  };

  const saveFourEyes = (): void => {
    if (busy !== null || closed) return;
    // Null is a real value and not an absence: the band is off, which is what
    // the accepted rule permits and what a zero would not mean.
    const value = off ? null : Number(threshold);
    if (value !== null && !Number.isFinite(value)) {
      setBecause('Type a number of dollars, or turn the band off.');
      return;
    }
    setBusy('four-eyes');
    setBecause(null);
    // The server's own echo wins over the number that was typed; the typed one
    // is the fallback for a build whose command answers without a detail.
    const keep = (echo: unknown): Confirmed => ({
      fourEyes: echo === null ? null : typeof echo === 'number' ? echo : value,
    });
    void props.client
      .mutate('settings.set_four_eyes_threshold', { value })
      .then((result) => settle('four-eyes', result, keep));
  };

  const saveSignOff = (): void => {
    if (busy !== null || closed) return;
    setBusy('sign-off');
    setBecause(null);
    const keep = (echo: unknown): Confirmed => ({
      signOff: typeof echo === 'boolean' ? echo : signOff,
    });
    void props.client
      .mutate('settings.set_client_sign_off', { value: signOff })
      .then((result) => settle('sign-off', result, keep));
  };

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

      {/*
        The honest state. It is not a read that failed — nothing was read,
        because there is no read to make. Saying "unavailable" here would claim
        the API was asked and did not answer.
      */}
      <p className="signin__ended" role="status" data-settings="not-readable">
        These values cannot be read back. The API exposes no read for business settings —{' '}
        <code>task.read</code>, <code>task.board</code>, <code>person.list</code> and{' '}
        <code>preset.plan</code> are the four it declares, and none of them carries them. What is
        shown below is the last write this browser had confirmed by the server, not the value the
        business holds.
      </p>

      {because === null ? null : (
        <p className="field__error" role="alert" data-settings="refusal">
          {because}
        </p>
      )}

      {!closed ? null : (
        <div className="readstate" data-outcome="denied" data-settings="closed">
          <Empty
            title="You are not permitted to change these settings."
            description="The server refused. The controls are closed rather than asking again on your behalf."
            hint="This is a decision the server made. Nothing on this screen has been changed."
          />
        </div>
      )}

      <section className="sb__sect">
        <div className="sb__sh">
          <span className="sb__k">Four-eyes threshold</span>
        </div>
        <p className="card__sub">
          The amount above which a second person must agree before money moves. Off means one person
          is enough at any amount.
        </p>
        <p className="card__sub" data-settings="four-eyes-known">
          Last confirmed by the server:{' '}
          {confirmed.fourEyes === undefined
            ? 'not known'
            : confirmed.fourEyes === null
              ? 'off'
              : String(confirmed.fourEyes)}
        </p>
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
            disabled={busy !== null || closed || off}
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
              disabled={busy !== null || closed}
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
          disabled={busy !== null || closed}
          onClick={saveFourEyes}
        >
          {busy === 'four-eyes' ? 'Saving…' : 'Save threshold'}
        </button>
      </section>

      <section className="sb__sect">
        <div className="sb__sh">
          <span className="sb__k">Client sign-off</span>
        </div>
        <p className="card__sub">
          Whether the client must agree before work is counted as complete.
        </p>
        <p className="card__sub" data-settings="sign-off-known">
          Last confirmed by the server:{' '}
          {confirmed.signOff === undefined ? 'not known' : confirmed.signOff ? 'on' : 'off'}
        </p>
        <div className="field">
          <label className="tf__k" htmlFor="settings-sign-off">
            <input
              id="settings-sign-off"
              type="checkbox"
              disabled={busy !== null || closed}
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
          disabled={busy !== null || closed}
          onClick={saveSignOff}
        >
          {busy === 'sign-off' ? 'Saving…' : 'Save sign-off'}
        </button>
      </section>
    </div>
  );
}
