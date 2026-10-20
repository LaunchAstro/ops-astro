// SPDX-License-Identifier: AGPL-3.0-only
//
// This business: whether the client is to agree before work is complete,
// written through `settings.set_client_sign_off`. Moved whole from
// `Settings.tsx` for its line cap; the screen hands in the conflict block and
// this browser's last confirmed value, which it draws for an unavailable read.

import { useState, type ReactElement } from 'react';
import { Held, OnOff, Written } from './panels.tsx';
import type { SettingsModel } from './use-settings.ts';

export function SignOffRow(props: {
  readonly model: SettingsModel;
  readonly known: ReactElement | null;
  readonly conflict: ReactElement | null;
}): ReactElement {
  const { model } = props;
  // What is in the control, which is what a person is proposing.
  const [signOff, setSignOff] = useState(false);
  return (
    <div className="setrow" data-set="sign-off">
      <div className="setrow__t">
        <h3 className="setrow__k">Client sign-off</h3>
        <p className="setrow__note">
          Whether the client is to agree before work is counted as complete.{' '}
          {/* Storage without a consumer, as the band above: nothing asks for it. */}
          <span data-settings="not-applied">
            Stored and shown only: no operation applies it yet.
          </span>
        </p>
        {model.answered ? <Written which="sign-off" row={model.rowFor('sign-off')} /> : null}
        {props.known}
      </div>
      <div className="setrow__ctl">
        <OnOff
          label="Require client sign-off"
          id="settings-sign-off"
          idFor="on"
          on={signOff}
          disabled={model.disabledFor('sign-off')}
          onChange={setSignOff}
        />
        <button
          className="btn btn--sm btn--primary"
          type="button"
          data-settings="save-sign-off"
          disabled={model.disabledFor('sign-off')}
          onClick={() => {
            model.save('sign-off', signOff);
          }}
        >
          {model.busy === 'sign-off' ? 'Saving…' : 'Save sign-off'}
        </button>
        {model.answered ? <Held which="sign-off" row={model.rowFor('sign-off')} /> : null}
      </div>
      {props.conflict}
    </div>
  );
}
