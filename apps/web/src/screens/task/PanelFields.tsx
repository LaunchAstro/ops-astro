// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel's field edits (MP-4-8): the name, the assignee, the due
// date (`PanelDue.tsx`), the estimate and the stage; the project is
// `ProjectField.tsx`, the category `CategoryField.tsx`, the status
// `StatusField.tsx`, the client and its duplicate `ClientField.tsx` (reads
// through `client-seam.ts`) and the tags `TagField.tsx` (MP-4-11).
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

import { StyledSelect } from '@launchastro/ui';
import { useState, type KeyboardEvent, type ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import {
  TASK_STAGES,
  type InternalTaskDetail as Task,
  type TaskStateView,
} from '../../../../../packages/core-wire/src/index.ts';
import { useCommand } from '../../records/use-command.ts';
import { submitEdit } from '../../records/submit.ts';
import { AssigneeField } from './AssigneeField.tsx';
import { holding, useHeldOperations } from './held-operations.ts';
import { ESTIMATE_CHOICES, estimateWords } from './estimates.ts';
import { DueField } from './PanelDue.tsx';
import { TagField } from './TagField.tsx';
import { useTaskAssignment } from './assignment-context.tsx';
import { AssignmentRecovery } from './AssignmentRecovery.tsx';
import { AssignToAI } from './AssignToAI.tsx';
import { ProjectField } from './ProjectField.tsx';
import { StatusField } from './StatusField.tsx';
import { ClientField } from './ClientField.tsx';
import type { ClientSeams } from './client-seam.ts';
import { CategoryField } from './CategoryField.tsx';
import { PageLink } from './PageLink.tsx';

export interface PanelFieldsProps extends ClientSeams {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly task: Task;
  /** The business's task states `task.read` sent, the Status select's choices. */
  readonly states?: readonly TaskStateView[];
  readonly onChanged: () => void;
}

type FieldCommand = 'task.update' | 'task.set_stage';

/**
 * One field write at the read revision, or the one an edit started from; a
 * landed one is counted. The same write sent again after a lost answer goes
 * under the same operation id, so the server replays what it stored.
 */
function useFieldWrite(props: Omit<PanelFieldsProps, 'grantKey'>) {
  const { busy, because, run } = useCommand();
  const held = useHeldOperations();
  const write = (
    command: FieldCommand,
    fields: Readonly<Record<string, unknown>>,
    revision = props.task.revision,
    onNotStored?: () => void,
  ): void => {
    const recordId = props.task.id;
    const hold = holding(held, command, { recordId, revision, fields }, () =>
      props.client.newOperationId(),
    );
    run(
      () =>
        submitEdit(props.client, {
          command,
          recordId,
          expectedRevision: revision,
          fields,
          operationId: hold.id,
        }),
      (settlement) => {
        hold.settle(settlement.kind);
        if (settlement.kind === 'ok') props.onChanged();
        else onNotStored?.();
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
  // The name being typed and the revision the rename opened at: a re-read
  // keeps the panel mounted, and a colleague's change since answers stale.
  const [draft, setDraft] = useState<{ text: string; revision: number } | null>(null);
  const [unsaved, setUnsaved] = useState<string | null>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      setDraft(null);
      setUnsaved(null);
    } else if (event.key === 'Enter' && draft !== null) {
      event.preventDefault();
      const name = draft.text.trim();
      setDraft(null);
      setUnsaved(null);
      if (name !== '' && name !== task.title) {
        write('task.update', { title: name }, draft.revision, () => setUnsaved(name));
      }
    }
  };
  return (
    <>
      {draft === null ? (
        <button
          className="sb__name"
          type="button"
          data-panel-field="name"
          disabled={busy}
          title="Rename"
          onClick={() => setDraft({ text: unsaved ?? task.title ?? '', revision: task.revision })}
        >
          {task.title}
        </button>
      ) : (
        <input
          id="panel-field-name"
          className="sb__name"
          aria-label="Task name"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the person pressed the name to edit it
          autoFocus
          value={draft.text}
          onChange={(event) => setDraft({ ...draft, text: event.target.value })}
          onKeyDown={onKeyDown}
        />
      )}
      <Refusal because={because} />
    </>
  );
}

export function PanelFields(props: PanelFieldsProps): ReactElement {
  const field = useFieldWrite(props);
  const assignment = useTaskAssignment(
    props.client,
    props.grantKey,
    props.task.id,
    props.onChanged,
  );
  return (
    <div className="dtp__fields">
      <div className="tf__row">
        <AssigneeField {...props} {...field} assignment={assignment} />
      </div>
      <div className="tf__row">
        <ClientField {...props} />
      </div>
      <div className="tf__row">
        <DueField {...props} {...field} />
      </div>
      <div className="tf__row">
        <EstimateField {...props} {...field} />
      </div>
      <FilingFields
        {...props}
        stage={
          <div className="tf__row">
            <StageField {...props} {...field} />
          </div>
        }
      />
      <AssignToAI
        client={props.client}
        task={props.task}
        scope="panel"
        grantKey={props.grantKey}
        recovery={false}
        onChanged={props.onChanged}
      />
      <AssignmentRecovery
        custody={assignment.custody}
        hold={assignment.hold}
        recordId={props.task.id}
      />
      <Refusal because={field.because} />
    </div>
  );
}

type FieldProps = PanelFieldsProps & ReturnType<typeof useFieldWrite>;

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
      <StyledSelect
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
      </StyledSelect>
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
      <StyledSelect
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
      </StyledSelect>
    </>
  );
}

function FilingFields(props: PanelFieldsProps & { readonly stage: ReactElement }): ReactElement {
  return (
    <>
      <div className="tf__row">
        <ProjectField
          client={props.client}
          grantKey={props.grantKey}
          task={props.task}
          onChanged={props.onChanged}
        />
      </div>
      <div className="tf__row">
        <CategoryField client={props.client} task={props.task} onChanged={props.onChanged} />
      </div>
      {props.stage}
      <div className="tf__row">
        <StatusField
          client={props.client}
          task={props.task}
          states={props.states ?? []}
          id="panel-field-status"
          onChanged={props.onChanged}
        />
      </div>
      <TagField client={props.client} task={props.task} onChanged={props.onChanged}>
        <div className="tf__row">
          <PageLink client={props.client} task={props.task} onChanged={props.onChanged} />
        </div>
      </TagField>
    </>
  );
}
