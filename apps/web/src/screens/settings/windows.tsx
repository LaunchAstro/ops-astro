// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-11 This business: the conversation and retention windows (CS-2.13), in
// whole days, each written through its own command with the revision the read
// carried. The rules between them (the conversation window at least seven
// days and never past the retention window) are the server's, and its refusal
// is drawn in its own words on the screen's refusal line.

import { useState, type ReactElement } from 'react';
import { Held, Written } from './panels.tsx';
import type { SettingsModel } from './use-settings.ts';

const WINDOWS = {
  conversation: {
    label: 'Conversation window',
    sentence:
      'How many days a conversation is kept. Seven days at least, and never longer than the retention window.',
  },
  retention: {
    label: 'Retention window',
    sentence:
      'How many days the business keeps its records by default. Never shorter than the conversation window.',
  },
} as const;

/** A whole number of days, or null for anything else. */
function daysIn(text: string): number | null {
  const value = Number(text);
  return text.trim() !== '' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function WindowRow(props: {
  readonly which: keyof typeof WINDOWS;
  readonly model: SettingsModel;
  readonly conflict: ReactElement | null;
}): ReactElement {
  const { which, model } = props;
  const [days, setDays] = useState('');
  const id = `settings-${which}`;
  const save = (): void => {
    const value = daysIn(days);
    if (value === null) model.complain('Type a whole number of days.');
    else model.save(which, value);
  };
  return (
    <div className="setrow" data-set={which}>
      <div className="setrow__t">
        <h3 className="setrow__k">{WINDOWS[which].label}</h3>
        <p className="setrow__note">{WINDOWS[which].sentence}</p>
        {model.answered ? <Written which={which} row={model.rowFor(which)} /> : null}
      </div>
      <div className="setrow__ctl">
        <div className="setrow__line">
          <label className="visually-hidden" htmlFor={id}>
            {`${WINDOWS[which].label} in days`}
          </label>
          <input
            id={id}
            className="tf setrow__num"
            type="number"
            min={0}
            step={1}
            placeholder="Days"
            disabled={model.disabled}
            value={days}
            onChange={(event) => {
              setDays(event.target.value);
            }}
          />
        </div>
        <button
          className="btn btn--sm btn--primary"
          type="button"
          data-settings={`save-${which}`}
          disabled={model.disabled}
          onClick={save}
        >
          {model.busy === which ? 'Saving…' : `Save ${WINDOWS[which].label.toLowerCase()}`}
        </button>
        {model.answered ? <Held which={which} row={model.rowFor(which)} /> : null}
      </div>
      {props.conflict}
    </div>
  );
}
