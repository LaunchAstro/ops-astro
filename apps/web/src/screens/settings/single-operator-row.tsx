// SPDX-License-Identifier: AGPL-3.0-only
//
// R5 (#1781) This business: single-operator mode, whether the business's one
// operator may Launch a live correction they asked for. Written through
// `settings.set_single_operator` under `settings:manage`, with the revision
// the read carried, and nothing else: who may Launch stays the server's. The
// server turns it on only while the business has one operator and turns it
// off when a second joins; its refusal is said on the screen's refusal line
// in plain words (`reads.ts`).

import { useState, type ReactElement } from 'react';
import { Held, OnOff, Written } from './panels.tsx';
import type { SettingsModel } from './use-settings.ts';

export function SingleOperatorRow(props: {
  readonly model: SettingsModel;
  readonly conflict: ReactElement | null;
}): ReactElement {
  const { model } = props;
  const row = model.rowFor('single-operator');
  const [on, setOn] = useState(false);
  return (
    <div className="setrow" data-set="single-operator">
      <div className="setrow__t">
        <h3 className="setrow__k">Single-operator mode</h3>
        <p className="setrow__note">
          Lets the business&apos;s one operator Launch a site change they asked for. Astra reviews
          the first such Launch. It turns off by itself when a second operator joins.
        </p>
        {model.answered ? <Written which="single-operator" row={row} /> : null}
      </div>
      <div className="setrow__ctl">
        <OnOff
          label="Single-operator mode"
          id="settings-single-operator"
          idFor="on"
          on={on}
          disabled={model.disabledFor('single-operator')}
          onChange={setOn}
        />
        <button
          className="btn btn--sm btn--primary"
          type="button"
          data-settings="save-single-operator"
          disabled={model.disabledFor('single-operator')}
          onClick={() => {
            model.save('single-operator', on);
          }}
        >
          {model.busy === 'single-operator' ? 'Saving…' : 'Save single-operator mode'}
        </button>
        {model.answered ? <Held which="single-operator" row={row} /> : null}
      </div>
      {props.conflict}
    </div>
  );
}
