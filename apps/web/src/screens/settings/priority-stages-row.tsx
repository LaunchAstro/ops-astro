// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactElement } from 'react';
import { TASK_STAGES, priorityStageIds } from '../../../../../packages/core-wire/src/index.ts';
import type { SettingView } from '../../../../../packages/core-wire/src/index.ts';
import type { SettingsModel } from './settings-model.ts';
import { Held, Written } from './panels.tsx';

export function PriorityStagesRow(props: {
  readonly model: SettingsModel;
  readonly conflict: ReactElement | null;
}): ReactElement {
  const model = props.model;
  const row = model.read.outcome === 'ready' ? model.rowFor('priority') : null;
  const value = row?.valueType === 'stage_ids' ? priorityStageIds(row.value) : undefined;
  const [edited, setEdited] = useState<readonly string[] | null>(null);
  const chosen = edited ?? value ?? [];
  // A matching authorised read leaves no unsent difference. Uncertainty keeps
  // the editor even when another writer happens to return the same array.
  if (
    edited !== null &&
    value !== undefined &&
    !model.priorityPending &&
    edited.length === value.length &&
    edited.every((id, at) => id === value[at])
  )
    setEdited(null);
  const change = (id: string, checked: boolean): void => {
    const selected = new Set(chosen);
    if (checked) selected.add(id);
    else selected.delete(id);
    setEdited(
      TASK_STAGES.list()
        .filter((stage) => !stage.internal && selected.has(stage.id))
        .map((stage) => stage.id),
    );
  };
  return (
    <div className="setrow" data-set="priority">
      <PriorityHeading row={value === undefined ? null : row} />
      <div className="setrow__ctl">
        <PriorityChoices model={model} chosen={chosen} change={change} />
        <button
          className="btn btn--sm"
          type="button"
          data-settings="clear-priority"
          disabled={!model.priorityEditable}
          onClick={() => setEdited([])}
        >
          Clear
        </button>
        <PriorityActions model={model} chosen={chosen} />
        {value === undefined ? null : <Held which="priority" row={row} />}
      </div>
      {props.conflict}
    </div>
  );
}

function PriorityChoices(props: {
  readonly model: SettingsModel;
  readonly chosen: readonly string[];
  readonly change: (id: string, checked: boolean) => void;
}): ReactElement {
  const { model, chosen, change } = props;
  return (
    <fieldset data-settings="priority-stages" disabled={!model.priorityEditable}>
      <legend className="visually-hidden">Priority journeys</legend>
      {TASK_STAGES.list()
        .filter((stage) => !stage.internal)
        .map((stage) => (
          <label key={stage.id} htmlFor={`settings-priority-${stage.id}`}>
            <input
              id={`settings-priority-${stage.id}`}
              type="checkbox"
              value={stage.id}
              checked={chosen.includes(stage.id)}
              onChange={(event) => change(stage.id, event.target.checked)}
            />
            {stage.label}
          </label>
        ))}
    </fieldset>
  );
}

function PriorityActions(props: {
  readonly model: SettingsModel;
  readonly chosen: readonly string[];
}): ReactElement {
  const { model, chosen } = props;
  return (
    <>
      <button
        className="btn btn--sm btn--primary"
        type="button"
        data-settings="save-priority"
        disabled={model.disabledFor('priority')}
        onClick={() => model.save('priority', chosen)}
      >
        {model.busy === 'priority'
          ? 'Saving…'
          : model.priorityUnknown
            ? 'Retry original change'
            : 'Save priorities'}
      </button>
      <button
        className="btn btn--sm"
        type="button"
        data-settings="read-priority"
        disabled={model.read.outcome === 'loading'}
        onClick={model.reload}
      >
        Read priorities again
      </button>
      {model.priorityUnknown ? (
        <p role="status" data-settings="priority-unknown">
          The original change may already have been stored. Its outcome remains unknown; retry keeps
          its original choices and revision.
        </p>
      ) : null}
    </>
  );
}

function PriorityHeading(props: { readonly row: SettingView | null }): ReactElement {
  const row = props.row;
  return (
    <div className="setrow__t">
      <h3 className="setrow__k">Priority stages</h3>
      <p className="setrow__note">
        Chosen journeys receive the priority multiplier in the permitted task rank pool. None keeps
        every journey neutral.
      </p>
      <Written which="priority" row={row} />
    </div>
  );
}
