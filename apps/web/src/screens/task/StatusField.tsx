// SPDX-License-Identifier: AGPL-3.0-only
//
// The Status select (MP-4-8 CS-4.18, DP-25; Stage 1 adds), drawn the same on
// the dock task panel and the task page.
//
// **The choices are the server's.** `task.read` sends the business's task
// states in the workflow's order, each with the id `task.set_state` takes;
// nothing here lists or orders them. A task whose state is not among them keeps
// it as itself, so the select never shows a state the task is not in.
//
// **One completion transition.** Complete (the completed category) is
// `task.complete`, never `task.set_state`, which refuses it (MP-4-13). Leaving
// Complete is `task.reopen` first, with its reason, which lands in the
// unstarted state; the chosen state then goes through `task.set_state` at the
// revision the reopen answered, unless the unstarted state was the choice. Each
// write is at the revision read; a landed one is counted (`onChanged`) and a
// refusal is quoted in the server's words.

import type { ReactElement } from 'react';
import {
  isRefusal,
  isUnavailable,
  type CallResult,
  type CommandOutcome,
  type OperationsClient,
} from '../../operations/client.ts';
import type {
  InternalTaskDetail as Task,
  TaskStateView,
} from '../../../../../packages/core-wire/src/index.ts';
import { useCommand } from '../../records/use-command.ts';

const REOPEN_REASON = 'Reopened from the status select.';

export interface StatusFieldProps {
  readonly client: OperationsClient;
  readonly task: Task;
  readonly states: readonly TaskStateView[];
  /** The select's id: `panel-field-status` or `task-field-status`. */
  readonly id: string;
  /** The host's own writes in flight or an unsaved edit (the task page). */
  readonly disabled?: boolean;
  readonly onChanged: () => void;
}

/** The one command, or the reopen then the command, that puts the task in `target`. */
async function sendState(
  client: OperationsClient,
  task: Task,
  target: TaskStateView,
): Promise<CallResult<CommandOutcome>> {
  const recordId = task.id;
  if (target.machineCategory === 'completed') {
    return await client.mutate('task.complete', { recordId }, { expectedRevision: task.revision });
  }
  let revision = task.revision;
  if (task.completedAt !== null) {
    const reopened = await client.mutate(
      'task.reopen',
      { recordId, reason: REOPEN_REASON },
      { expectedRevision: revision },
    );
    if (isRefusal(reopened) || isUnavailable(reopened)) return reopened;
    if (target.machineCategory === 'unstarted') return reopened;
    revision = reopened.value.revision;
  }
  return await client.mutate(
    'task.set_state',
    { recordId, stateId: target.id },
    { expectedRevision: revision },
  );
}

export function StatusField(props: StatusFieldProps): ReactElement {
  const { client, task, states } = props;
  const { busy, because, run } = useCommand();
  const current = task.state;
  const off = current !== null && !states.some((each) => each.id === current.id);

  const choose = (stateId: string): void => {
    const target = states.find((each) => each.id === stateId);
    if (target === undefined || stateId === current?.id) return;
    run(
      () => sendState(client, task, target),
      (settlement) => {
        if (settlement.kind === 'ok') props.onChanged();
      },
    );
  };

  return (
    <>
      <label className="tf__k" htmlFor={props.id}>
        Status
      </label>
      <select
        id={props.id}
        className="input"
        disabled={busy || props.disabled === true}
        value={current?.id ?? ''}
        onChange={(event) => choose(event.target.value)}
      >
        {current === null ? <option value="">Not set</option> : null}
        {states.map((each) => (
          <option key={each.id} value={each.id}>
            {each.label}
          </option>
        ))}
        {off ? <option value={current.id}>{current.label}</option> : null}
      </select>
      {because === null ? null : (
        <p className="field__error" role="alert">
          {because}
        </p>
      )}
    </>
  );
}

/** The task page's Status select, in the page's own section. */
export function PageStatus(props: Omit<StatusFieldProps, 'id'>): ReactElement {
  return (
    <section className="sb__sect tf__grid" data-task-status>
      <StatusField {...props} id="task-field-status" />
    </section>
  );
}
