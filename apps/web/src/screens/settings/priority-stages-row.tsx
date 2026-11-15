// SPDX-License-Identifier: AGPL-3.0-only
//
// U110 This business: the journey stages whose tasks rank with the priority
// weight. Written through `settings.set_priority_stages` with the revision the
// ticked set was built on, so a change saved since is a conflict; the server
// checks the ids and puts them in journey order. With no row read there is
// nothing to build on, so the stages and Save are held.

import { useState, type ReactElement } from 'react';
import { TASK_STAGES } from '../../../../../packages/core-wire/src/index.ts';
import { Held, Written } from './panels.tsx';
import type { SettingsModel } from './use-settings.ts';

const JOURNEY = TASK_STAGES.list().filter((stage) => !stage.internal);

interface Ticked {
  readonly owner: string;
  readonly since: number | undefined;
  readonly ids: readonly string[];
  /** The revision `ids` was built on: the row read at the first tick, or this owner's save. */
  readonly base: number | undefined;
}

/**
 * What this owner has ticked, or the business's stages, and the revision that
 * set was built on. A switch drops it, and so does a read showing a save
 * confirmed after it was ticked; until that read answers, a pending or failed
 * one included, it is what was saved (#1204), built on that save. Any other
 * reread keeps the base it was ticked on, so Save meets the conflict.
 */
function usePriorityDraft(model: SettingsModel): {
  readonly chosen: readonly string[];
  readonly base: number | undefined;
  readonly toggle: (id: string, on: boolean) => void;
} {
  const row = model.rowFor('priority');
  const value = row?.value;
  const held: readonly string[] = Array.isArray(value) ? value : [];
  const owner = model.ownerKey;
  const wrote = model.wrote('priority');
  const shown = wrote !== undefined && row?.revision !== undefined && row.revision >= wrote;
  const [ticked, setTicked] = useState<Ticked | null>(null);
  const kept = ticked !== null && ticked.owner === owner && (ticked.since === wrote || !shown);
  if (ticked !== null && !kept) setTicked(null);
  const chosen = kept ? ticked.ids : held;
  const base = kept ? (ticked.since === wrote ? ticked.base : wrote) : row?.revision;
  const toggle = (id: string, on: boolean): void => {
    const ids = JOURNEY.filter((stage) => (stage.id === id ? on : chosen.includes(stage.id)));
    setTicked({ owner, since: wrote, ids: ids.map((stage) => stage.id), base });
  };
  return { chosen, base, toggle };
}

export function PriorityStagesRow(props: {
  readonly model: SettingsModel;
  /** The conflict block, given the boxes ticked now: Write over it writes those. */
  readonly conflict: (chosen: readonly string[]) => ReactElement | null;
}): ReactElement {
  const { model } = props;
  const row = model.rowFor('priority');
  const { chosen, base, toggle } = usePriorityDraft(model);
  const disabled = model.disabledFor('priority') || row === null;
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
          onClick={() => model.save('priority', chosen, base)}
        >
          {model.busy === 'priority' ? 'Saving…' : 'Save priority stages'}
        </button>
        {model.answered ? <Held which="priority" row={row} /> : null}
      </div>
      {props.conflict(chosen)}
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
