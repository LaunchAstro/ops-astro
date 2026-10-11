// SPDX-License-Identifier: AGPL-3.0-only
//
// U110 This business: the journey stages whose tasks rank with the priority
// weight. Written through `settings.set_priority_stages` with the revision the
// read carried; the server checks the ids and puts them in journey order.

import { useState, type ReactElement } from 'react';
import { TASK_STAGES } from '../../../../../packages/core-wire/src/index.ts';
import { Held, Written } from './panels.tsx';
import type { SettingsModel } from './use-settings.ts';

const JOURNEY = TASK_STAGES.list().filter((stage) => !stage.internal);

export function PriorityStagesRow(props: {
  readonly model: SettingsModel;
  readonly conflict: ReactElement | null;
}): ReactElement {
  const { model } = props;
  const row = model.rowFor('priority');
  const value = row?.value;
  const held: readonly string[] = Array.isArray(value) ? value : [];
  // What the person has ticked since the read, or the business's stages until then.
  const [ticked, setTicked] = useState<readonly string[] | null>(null);
  const chosen = ticked ?? held;
  const toggle = (id: string, on: boolean): void => {
    setTicked(
      JOURNEY.filter((stage) => (stage.id === id ? on : chosen.includes(stage.id))).map(
        (stage) => stage.id,
      ),
    );
  };
  const disabled = model.disabledFor('priority');
  return (
    <div className="setrow" data-set="priority">
      <div className="setrow__t">
        <h3 className="setrow__k">Priority stages</h3>
        <p className="setrow__note">
          Tasks in these stages rank a quarter higher. Choose none and every stage ranks the same.
        </p>
        {model.answered ? <Written which="priority" row={row} /> : null}
      </div>
      <div className="setrow__ctl">
        <StageChoices chosen={chosen} disabled={disabled} toggle={toggle} />
        <button
          className="btn btn--sm btn--primary"
          type="button"
          data-settings="save-priority"
          disabled={disabled}
          onClick={() => model.save('priority', chosen)}
        >
          {model.busy === 'priority' ? 'Saving…' : 'Save priority stages'}
        </button>
        {model.answered ? <Held which="priority" row={row} /> : null}
      </div>
      {props.conflict}
    </div>
  );
}

function StageChoices(props: {
  readonly chosen: readonly string[];
  readonly disabled: boolean;
  readonly toggle: (id: string, on: boolean) => void;
}): ReactElement {
  return (
    <fieldset data-settings="priority-stages" disabled={props.disabled}>
      <legend className="visually-hidden">Priority stages</legend>
      {JOURNEY.map((stage) => (
        <label key={stage.id} htmlFor={`settings-priority-${stage.id}`}>
          <input
            id={`settings-priority-${stage.id}`}
            type="checkbox"
            value={stage.id}
            checked={props.chosen.includes(stage.id)}
            onChange={(event) => props.toggle(stage.id, event.target.checked)}
          />
          {stage.label}
        </label>
      ))}
    </fieldset>
  );
}
