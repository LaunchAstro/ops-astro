// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel's Category select (MP-4-8, CS-4.16, DP-23).
//
// **The choices are the catalogue's.** Not set, then the nine of
// `TASK_CATEGORIES` in the list's order; a stored value off the list stays
// among the choices as itself, so the select never shows a label the task
// does not carry.
//
// **A work label only** (R76). The choice goes out through
// `task.set_category` (`task:write`) as the category's id, or null for Not
// set, at the revision the panel read; it touches nothing else, the Agent
// scope stamp included (the mockup's rewrite of it is a bug, not copied). A
// change that lands is counted (`onChanged`); a refusal is quoted in the
// server's words.

import type { ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import {
  TASK_CATEGORIES,
  type InternalTaskDetail as Task,
} from '../../../../../packages/core-wire/src/index.ts';
import { useCommand } from '../../records/use-command.ts';
import { submitEdit } from '../../records/submit.ts';

export interface CategoryFieldProps {
  readonly client: OperationsClient;
  readonly task: Task;
  readonly onChanged: () => void;
}

export function CategoryField(props: CategoryFieldProps): ReactElement {
  const { client, task } = props;
  const { busy, because, run } = useCommand();
  const category = task.category ?? null;
  const categories = TASK_CATEGORIES.list();
  const off = category !== null && !TASK_CATEGORIES.has(category);

  const choose = (value: string): void => {
    run(
      () =>
        submitEdit(client, {
          command: 'task.set_category',
          recordId: task.id,
          expectedRevision: task.revision,
          fields: { category: value === '' ? null : value },
        }),
      (settlement) => {
        if (settlement.kind === 'ok') props.onChanged();
      },
    );
  };

  return (
    <>
      <label className="tf__k" htmlFor="panel-field-category">
        Category
      </label>
      <select
        id="panel-field-category"
        className="input"
        disabled={busy}
        value={category ?? ''}
        onChange={(event) => choose(event.target.value)}
      >
        <option value="">Not set</option>
        {categories.map((each) => (
          <option key={each.id} value={each.id}>
            {each.label}
          </option>
        ))}
        {off ? <option value={category}>{category}</option> : null}
      </select>
      {because === null ? null : (
        <p className="field__error" role="alert">
          {because}
        </p>
      )}
    </>
  );
}
