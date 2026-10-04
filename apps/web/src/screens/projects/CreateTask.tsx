// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects board's New task form (B1): `task.create` with `board: null`,
// the business's unboarded tasks. An attempt whose outcome is unknown is kept
// and sent again as the same attempt, so a retry never makes a second task.

import { useState, type FormEvent, type ReactElement } from 'react';
import { Icon } from '@launchastro/ui';
import type { OperationsClient } from '../../operations/client.ts';
import { useCommand, type Settlement } from '../../records/use-command.ts';

/** A create whose outcome is not known, held so the retry is the same attempt. */
interface PendingCreate {
  readonly operationId: string;
  readonly title: string;
}

/**
 * What the form holds for one reader: the title being typed and the unresolved
 * attempt. It is the reader's whose client typed it, so another business or
 * person opens on an empty form and nothing typed for one is sent as another.
 */
interface Draft {
  readonly of: OperationsClient;
  readonly title: string;
  readonly pending: PendingCreate | null;
}

const empty = (of: OperationsClient): Draft => ({ of, title: '', pending: null });

/** A change to one reader's draft. */
type DraftChange = (edit: (draft: Draft) => Draft) => void;

/**
 * The settlement of one create. `unknown` is the one case the attempt is kept
 * for: the task may or may not exist. Anything else is a known outcome and the
 * attempt is over: a refusal is a decision, and holding it would resend an
 * identity the server has settled.
 *
 * On success it clears only the text this create was for. The input is
 * disabled while the request is in flight so there should be nothing newer,
 * but a settlement that clears whatever happens to be in the box is the same
 * defect as the task form's: a late success erasing the next task's title.
 * Bind it to what was submitted and it cannot.
 */
function settled(
  attempt: PendingCreate,
  change: DraftChange,
  onCreated: () => void,
): (settlement: Settlement) => void {
  return (settlement) => {
    if (settlement.kind === 'unknown') return;
    change((draft) => ({ ...draft, pending: null }));
    if (settlement.kind !== 'ok') return;
    change((draft) => (draft.title.trim() === attempt.title ? { ...draft, title: '' } : draft));
    onCreated();
  };
}

/**
 * The form's state and its two actions.
 *
 * While `creating` is true the create is in flight and the form is not
 * editable: the input, the submit and `Start a different task` are all
 * disabled. A person who can type a second title during the first create is a
 * person whose second title a delayed success will wipe. `locked` adds
 * `closed`: `task.create` is this form's one command, so a refusal about this
 * reader's authority closes the form rather than letting it ask again, as the
 * comment box and the propose form do.
 *
 * `pending` is the attempt whose outcome nobody knows. A create that ended
 * `unavailable` may well have committed on the server, so its identity and
 * its exact payload are kept and presented again on the next submission.
 * Minting a fresh id instead would make the server's replay register
 * unreachable and the retry would create a second task. It is the same attempt
 * while the asked-for task is the same one, a new attempt when the person has
 * changed what they are asking for: retrying an unknown outcome and
 * deliberately starting a second task are different intentions and the title
 * is what tells them apart; `startNew` says it outright.
 *
 * `board: null` is explicit. The acceptance case is a task with no board, and
 * leaving the field out would let a server default decide.
 */
function useCreateTask(client: OperationsClient, onCreated: () => void) {
  const command = useCommand();
  const { locked, run, reset } = command;
  const [held, setHeld] = useState<Draft>(() => empty(client));
  const { title, pending } = held.of === client ? held : empty(client);
  /** The form's own change: to this reader's draft, never another's carried over. */
  const own: DraftChange = (edit) => {
    setHeld((before) => edit(before.of === client ? before : empty(client)));
  };
  /** A settlement's change: to the draft it was sent from, or nothing once that has gone. */
  const sentFrom: DraftChange = (edit) => {
    setHeld((before) => (before.of === client ? edit(before) : before));
  };
  const setTitle = (next: string): void => {
    own((draft) => ({ ...draft, title: next }));
  };

  const onCreate = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const asked = title.trim();
    if (locked || asked === '') return;
    const attempt =
      pending !== null && pending.title === asked
        ? pending
        : { operationId: client.newOperationId(), title: asked };
    own((draft) => ({ ...draft, pending: attempt }));
    run(
      () =>
        client.mutate(
          'task.create',
          { fields: { title: attempt.title }, board: null },
          { operationId: attempt.operationId },
        ),
      settled(attempt, sentFrom, onCreated),
    );
  };

  /** Abandon an unresolved attempt and ask for a genuinely different task. */
  const startNew = (): void => {
    setHeld(empty(client));
    reset();
  };

  return { ...command, title, setTitle, pending, onCreate, startNew };
}

export function CreateTask(props: {
  readonly client: OperationsClient;
  /** A task was made: the board reads again. */
  readonly onCreated: () => void;
}): ReactElement {
  const form = useCreateTask(props.client, props.onCreated);
  const { busy: creating, because, locked, title, pending } = form;
  const retrying = pending !== null && pending.title === title.trim();

  return (
    // The mockup's quick-add field ("Add another…", P-02) and its New task
    // button (P-06): one form, sending task.create.
    <form className="projects__create" onSubmit={form.onCreate}>
      <label className="visually-hidden" htmlFor="create-title">
        New task
      </label>
      {/* The board's quick-add field (P-02, B-01): the box is the field, the input draws nothing. */}
      <span className="cbd__field">
        <Icon name="plus" size="xs" />
        <input
          id="create-title"
          type="text"
          required
          placeholder="Add a task…"
          disabled={locked}
          value={title}
          onChange={(event) => {
            form.setTitle(event.target.value);
          }}
        />
      </span>
      {/* Pressable while the title is empty, as the mockup's is: the field is
          `required` and onCreate sends nothing without a title. */}
      <button
        className="btn btn--secondary btn--sm"
        type="submit"
        data-attempt={retrying ? 'retry' : 'new'}
        disabled={locked}
      >
        {creating ? 'Creating…' : retrying ? 'Retry create' : 'Create task'}
      </button>
      <Unresolved
        pending={pending}
        because={because}
        creating={creating}
        onDiscard={form.startNew}
      />
    </form>
  );
}

/** The discard button and the words an unresolved or refused create shows. */
function Unresolved(props: {
  readonly pending: PendingCreate | null;
  readonly because: string | null;
  readonly creating: boolean;
  readonly onDiscard: () => void;
}): ReactElement {
  const { pending, because } = props;
  return (
    <>
      {pending === null ? null : (
        <button
          className="btn btn--sm"
          type="button"
          data-attempt="discard"
          disabled={props.creating}
          onClick={props.onDiscard}
        >
          Start a different task
        </button>
      )}
      {because === null ? null : (
        <p className="field__error" role="alert" data-voice="input-wrong">
          {because}
        </p>
      )}
      {pending === null || because === null ? null : (
        <p className="card__sub" data-attempt="unresolved">
          This task may already have been created. Retrying sends the same attempt, so the server
          answers with the original result rather than making a second task.
        </p>
      )}
    </>
  );
}
