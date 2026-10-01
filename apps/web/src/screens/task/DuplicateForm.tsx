// SPDX-License-Identifier: AGPL-3.0-only
//
// "Duplicate without contents" (MP-4-8, CS-4.12, DP-19; the owner's design of
// 28 September 2026): a new task for another client from the old task's bare
// shell, which the person sees and edits first.
//
// **Only the shell is carried.** The title and the names of the subtasks are
// prefilled from the old task and each is marked "Carried from the old task";
// the request holds the chosen client and that shell as edited, and nothing
// else, so nothing else can carry over.
//
// **The warning is the server's.** When carried text names the old client (or
// an alias on its record), the sender answers `CARRIED_TEXT_NAMES_CLIENT`
// naming the fields (`title`, `stepNames.<index>`). Each named field is
// warned, and Create waits for the person to confirm the carried text; the
// resend says `confirmCarried`. A confirm covers only the shell and client the
// server warned on: any edit to a carried field or the client withdraws it, so
// the next send is unconfirmed and the server checks every field again
// (REVIEW-2D-1). A warning that comes back after such an edit, made while
// Create was in flight, asks for no confirm: it was on a shell or client no
// longer on screen. Editing a warned field also clears its warning. Any other
// refusal is quoted in the server's words; a landed duplicate hands the new
// task's key to the host.

import { useRef, useState, type ReactElement } from 'react';
import type { WireRefusal } from '../../operations/client.ts';
import type { InternalTaskDetail as Task } from '../../../../../packages/core-wire/src/index.ts';
import { useCommand } from '../../records/use-command.ts';
import {
  CARRIED_TEXT_NAMES_CLIENT,
  type ClientChoice,
  type DuplicateRequest,
  type DuplicateSender,
} from './client-seam.ts';

export interface DuplicateFormProps {
  readonly task: Task;
  /** The clients it may be started for: every choice but the task's own. */
  readonly choices: readonly ClientChoice[];
  readonly send: DuplicateSender;
  readonly onDuplicated: (key: string) => void;
  readonly onCancel: () => void;
}

interface Shell {
  readonly title: string;
  readonly stepNames: readonly string[];
}

const carriedWarning = (refusal: WireRefusal): boolean => {
  const code: string = refusal.code;
  return code === CARRIED_TEXT_NAMES_CLIENT;
};

function CarriedField(props: {
  readonly id: string;
  readonly field: string;
  readonly label: string;
  readonly value: string;
  readonly warned: boolean;
  readonly onChange: (value: string) => void;
}): ReactElement {
  return (
    <div className="stack" data-carried={props.field}>
      <label className="tf__k" htmlFor={props.id}>
        {props.label}
      </label>
      <input
        id={props.id}
        className="input"
        value={props.value}
        aria-invalid={props.warned ? true : undefined}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <span className="field__hint">Carried from the old task</span>
      {props.warned ? (
        <span className="field__error" data-carried-warning>
          This carried text names the old task’s client.
        </span>
      ) : null}
    </div>
  );
}

/** The shell as the old task holds it: its title and its subtasks' names. */
const shellOf = (task: Task): Shell => ({
  title: task.title ?? '',
  stepNames: task.steps.map((step) => step.title ?? ''),
});

/**
 * The confirm for carried text: none to give (nothing warned, or edited since
 * the warning, so the next send is checked again), asked on the warned shell,
 * or given for it.
 */
type Confirm = 'unasked' | 'asked' | 'given';

/**
 * The shell as edited, the chosen client, the fields warned, and the send.
 * `edits` counts edits to the shell or client, so a warning that settles after
 * one knows the shell it warned on is no longer the one on screen.
 */
function useDuplicate(props: DuplicateFormProps) {
  const { task } = props;
  const [shell, setShell] = useState<Shell>(() => shellOf(task));
  const [client, setChosen] = useState('');
  const [warned, setWarned] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState<Confirm>('unasked');
  const command = useCommand();
  const edits = useRef(0);
  const setClient = (next: string): void => {
    edits.current += 1;
    setChosen(next);
    setConfirm('unasked');
  };
  const edit = (field: string, next: Shell): void => {
    edits.current += 1;
    setShell(next);
    setConfirm('unasked');
    if (!warned.has(field)) return;
    const rest = new Set(warned);
    rest.delete(field);
    setWarned(rest);
  };
  const create = (): void => {
    const request: DuplicateRequest = {
      recordId: task.id,
      client,
      title: shell.title.trim(),
      stepNames: shell.stepNames.map((name) => name.trim()),
      confirmCarried: confirm === 'given',
    };
    const sentAt = edits.current;
    command.run(
      () => props.send(request),
      (settlement) => {
        if (settlement.kind === 'ok') {
          const key = settlement.value.detail?.['key'];
          if (typeof key === 'string') props.onDuplicated(key);
        } else if (settlement.kind !== 'unknown' && carriedWarning(settlement.refusal)) {
          if (edits.current !== sentAt) return;
          setWarned(new Set(settlement.refusal.names));
          setConfirm('asked');
        }
      },
    );
  };
  const ready = client !== '' && shell.title.trim() !== '' && confirm !== 'asked';
  return { shell, client, setClient, warned, confirm, setConfirm, command, edit, create, ready };
}

type Duplicate = ReturnType<typeof useDuplicate>;

function ClientPick(props: {
  readonly choices: readonly ClientChoice[];
  readonly form: Duplicate;
}): ReactElement {
  return (
    <>
      <label className="tf__k" htmlFor="duplicate-client">
        Client
      </label>
      <select
        id="duplicate-client"
        className="input"
        value={props.form.client}
        onChange={(event) => props.form.setClient(event.target.value)}
      >
        <option value="">Choose a client</option>
        {props.choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.name}
          </option>
        ))}
      </select>
    </>
  );
}

/** The title and each subtask's name, carried and editable. */
function CarriedShell(props: { readonly form: Duplicate }): ReactElement {
  const { shell, warned, edit } = props.form;
  return (
    <>
      <CarriedField
        id="duplicate-title"
        field="title"
        label="Title"
        value={shell.title}
        warned={warned.has('title')}
        onChange={(title) => edit('title', { ...shell, title })}
      />
      {shell.stepNames.map((name, index) => {
        const field = `stepNames.${index}`;
        return (
          <CarriedField
            key={field}
            id={`duplicate-step-${index}`}
            field={field}
            label={`Subtask ${index + 1}`}
            value={name}
            warned={warned.has(field)}
            onChange={(text) =>
              edit(field, { ...shell, stepNames: shell.stepNames.with(index, text) })
            }
          />
        );
      })}
    </>
  );
}

/** The confirmation while a warning shows, with the server's words; or any other refusal, quoted. */
function Answer(props: { readonly form: Duplicate }): ReactElement | null {
  const { warned, confirm, setConfirm, command } = props.form;
  const failure = command.failure;
  const refusal = failure === null || failure.kind === 'unknown' ? null : failure.refusal;
  if (refusal !== null && carriedWarning(refusal)) {
    return warned.size === 0 || confirm === 'unasked' ? null : (
      <label className="field__hint" htmlFor="duplicate-confirm">
        <input
          id="duplicate-confirm"
          type="checkbox"
          checked={confirm === 'given'}
          onChange={(event) => setConfirm(event.target.checked ? 'given' : 'asked')}
        />{' '}
        {refusal.fixes.join(' ')} Keep the carried text as it is.
      </label>
    );
  }
  return failure === null ? null : (
    <p className="field__error" role="alert">
      {failure.because}
    </p>
  );
}

export function DuplicateForm(props: DuplicateFormProps): ReactElement {
  const form = useDuplicate(props);
  return (
    <form
      className="stack"
      aria-label="Duplicate without contents"
      onSubmit={(event) => {
        event.preventDefault();
        form.create();
      }}
    >
      <h3 className="t-title">Duplicate without contents</h3>
      <p className="field__hint">
        A new task for the client you choose, from this shell only. This task stays as it is.
      </p>
      <ClientPick choices={props.choices} form={form} />
      <CarriedShell form={form} />
      <Answer form={form} />
      <div className="dtp__head">
        <button
          className="btn btn--primary"
          type="submit"
          data-duplicate="create"
          disabled={form.command.busy || !form.ready}
        >
          Create
        </button>
        <button className="btn" type="button" data-duplicate="cancel" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
