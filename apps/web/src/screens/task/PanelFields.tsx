// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel's field edits (MP-4-8): the name, the assignee, the due
// date, the estimate and the stage; the project is `ProjectField.tsx`, the
// category `CategoryField.tsx`, the status `StatusField.tsx`, the client and
// its duplicate `ClientField.tsx` (reads through `client-seam.ts`) and the tags
// `TagField.tsx` (MP-4-11).
//
// **Each field through its own command, at the revision the panel read.** The
// name, the due date and the estimate go out through `task.update`
// (`task:write`), the stage through `task.set_stage` (`task:write`), the
// assignee through `task.assign` (`task:assign`). A change that lands asks the
// host to count it (`onChanged`), so the panel and the page read the task
// again and draw what the server holds; a refusal is quoted in the server's
// words and nothing is drawn as changed.
//
// **A control's Escape is the control's.** The name edit's Escape ends the
// edit; the picker marks its own handled (TR-A3-3).

import { useState, type KeyboardEvent, type ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import {
  TASK_STAGES,
  type InternalTaskDetail as Task,
  type PersonListResult,
  type TaskStateView,
} from '../../../../../packages/core-wire/src/index.ts';
import { useRead } from '../../data/use-read.ts';
import { useCommand } from '../../records/use-command.ts';
import { submitEdit } from '../../records/submit.ts';
import { RecordState } from '../../views/record-state.tsx';
import { DatePicker } from './DatePicker.tsx';
import { todayOn } from './due-dates.ts';
import { ESTIMATE_CHOICES, estimateWords } from './estimates.ts';
import { TagField } from './TagField.tsx';
import { AssignToAI } from './AssignToAI.tsx';
import { ProjectField } from './ProjectField.tsx';
import { StatusField } from './StatusField.tsx';
import { ClientField } from './ClientField.tsx';
import type { ClientSeams } from './client-seam.ts';
import { CategoryField } from './CategoryField.tsx';

export interface PanelFieldsProps extends ClientSeams {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly task: Task;
  /** The business's task states `task.read` sent, the Status select's choices. */
  readonly states?: readonly TaskStateView[];
  readonly onChanged: () => void;
}

type FieldCommand = 'task.update' | 'task.assign' | 'task.set_stage';

/** One field write at the read revision; a landed one is counted. */
function useFieldWrite(props: Omit<PanelFieldsProps, 'grantKey'>) {
  const { busy, because, run } = useCommand();
  const write = (command: FieldCommand, fields: Readonly<Record<string, unknown>>): void => {
    run(
      () =>
        submitEdit(props.client, {
          command,
          recordId: props.task.id,
          expectedRevision: props.task.revision,
          fields,
        }),
      (settlement) => {
        if (settlement.kind === 'ok') props.onChanged();
      },
    );
  };
  return { busy, because, write };
}

const Refusal = (props: { readonly because: string | null }): ReactElement | null =>
  props.because === null ? null : (
    <p className="field__error" role="alert">
      {props.because}
    </p>
  );

/** The task's name in the panel head, edited in place: Enter saves, Escape leaves it. */
export function PanelName(props: Omit<PanelFieldsProps, 'grantKey'>): ReactElement {
  const { task } = props;
  const { busy, because, write } = useFieldWrite(props);
  const [draft, setDraft] = useState<string | null>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      setDraft(null);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const name = (draft ?? '').trim();
      setDraft(null);
      if (name !== '' && name !== task.title) write('task.update', { title: name });
    }
  };
  return (
    <>
      {draft === null ? (
        <button
          className="btn btn--ghost"
          type="button"
          data-panel-field="name"
          disabled={busy}
          title="Rename"
          onClick={() => setDraft(task.title)}
        >
          {task.title}
        </button>
      ) : (
        <input
          id="panel-field-name"
          className="input"
          aria-label="Task name"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the person pressed the name to edit it
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
      )}
      <Refusal because={because} />
    </>
  );
}

export function PanelFields(props: PanelFieldsProps): ReactElement {
  const field = useFieldWrite(props);
  return (
    <div className="dtp__fields">
      <AssigneeField {...props} {...field} />
      <AssignToAI
        client={props.client}
        task={props.task}
        scope="panel"
        onChanged={props.onChanged}
      />
      <DueField {...props} {...field} />
      <EstimateField {...props} {...field} />
      <CategoryField client={props.client} task={props.task} onChanged={props.onChanged} />
      <StageField {...props} {...field} />
      <StatusField
        client={props.client}
        task={props.task}
        states={props.states ?? []}
        id="panel-field-status"
        onChanged={props.onChanged}
      />
      <ProjectField
        client={props.client}
        grantKey={props.grantKey}
        task={props.task}
        onChanged={props.onChanged}
      />
      <ClientField {...props} />
      <TagField client={props.client} task={props.task} onChanged={props.onChanged} />
      <Refusal because={field.because} />
    </div>
  );
}

type FieldProps = PanelFieldsProps & ReturnType<typeof useFieldWrite>;

/** A person or nobody, from the people this business can be assigned work. */
function AssigneeField(props: FieldProps): ReactElement {
  const { client, task } = props;
  const people = useRead<PersonListResult>({
    grantKey: props.grantKey,
    run: () => client.read<PersonListResult>('person.list', {}),
    deps: [],
  });
  return (
    <>
      <label className="tf__k" htmlFor="panel-field-assignee">
        Assignee
      </label>
      <RecordState state={people.state} subject="people" onRetry={people.reload}>
        {(value) => (
          <select
            id="panel-field-assignee"
            className="input"
            disabled={props.busy}
            value={task.assignee?.personId ?? ''}
            onChange={(event) =>
              props.write('task.assign', {
                assignee: event.target.value === '' ? null : event.target.value,
              })
            }
          >
            <option value="">Unassigned</option>
            {value.persons.map((person) => (
              <option key={person.personId} value={person.personId}>
                {person.name}
              </option>
            ))}
          </select>
        )}
      </RecordState>
    </>
  );
}

/** The due date, chosen in the picker; choosing the day it already has sends nothing. */
function DueField(props: FieldProps): ReactElement {
  const [picking, setPicking] = useState(false);
  const due = props.task.due?.slice(0, 10) ?? null;
  const choose = (day: string | null): void => {
    setPicking(false);
    if (day !== due) props.write('task.update', { due: day });
  };
  return (
    <>
      <span className="tf__k">Due</span>
      <button
        className="btn"
        type="button"
        data-panel-field="due"
        aria-expanded={picking}
        disabled={props.busy}
        onClick={() => setPicking(!picking)}
      >
        {due ?? 'Not set'}
      </button>
      {picking ? (
        <DatePicker
          value={due}
          today={todayOn(new Date())}
          onChoose={choose}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </>
  );
}

/** The estimate, from the vocabulary; one stored off it stays among the choices as itself. */
function EstimateField(props: FieldProps): ReactElement {
  const minutes = props.task.estimateMinutes ?? null;
  const choices =
    minutes === null || ESTIMATE_CHOICES.includes(minutes)
      ? ESTIMATE_CHOICES
      : [...ESTIMATE_CHOICES, minutes].toSorted((a, b) => a - b);
  return (
    <>
      <label className="tf__k" htmlFor="panel-field-estimate">
        Estimate
      </label>
      <select
        id="panel-field-estimate"
        className="input"
        disabled={props.busy}
        value={minutes === null ? '' : String(minutes)}
        onChange={(event) =>
          props.write('task.update', {
            estimated_minutes: event.target.value === '' ? null : Number(event.target.value),
          })
        }
      >
        <option value="">Not set</option>
        {choices.map((choice) => (
          <option key={choice} value={String(choice)}>
            {estimateWords(choice)}
          </option>
        ))}
      </select>
    </>
  );
}

/** The stage, from the task stage list the board reads; one stored off it stays as itself. */
function StageField(props: FieldProps): ReactElement {
  const stage = props.task.stage;
  const stages = TASK_STAGES.list();
  const off = stage !== null && !stages.some((each) => each.id === stage);
  return (
    <>
      <label className="tf__k" htmlFor="panel-field-stage">
        Stage
      </label>
      <select
        id="panel-field-stage"
        className="input"
        disabled={props.busy}
        value={stage ?? ''}
        onChange={(event) =>
          props.write('task.set_stage', {
            stage: event.target.value === '' ? null : event.target.value,
          })
        }
      >
        <option value="">Not set</option>
        {stages.map((each) => (
          <option key={each.id} value={each.id}>
            {each.label}
          </option>
        ))}
        {off ? <option value={stage}>{stage}</option> : null}
      </select>
    </>
  );
}
