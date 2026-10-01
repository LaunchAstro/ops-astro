// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects board's New task form (B1): `task.create` with `board: null`,
// the business's unboarded tasks. An attempt whose outcome is unknown is kept
// and sent again as the same attempt, so a retry never makes a second task.

import { useState, type FormEvent, type ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import { useCommand } from '../../records/use-command.ts';

/** A create whose outcome is not known, held so the retry is the same attempt. */
interface PendingCreate {
  readonly operationId: string;
  readonly title: string;
}

export function CreateTask(props: {
  readonly client: OperationsClient;
  /** A task was made: the board reads again. */
  readonly onCreated: () => void;
}): ReactElement {
  const client = props.client;
  // While this is true the create is in flight and the form is not editable:
  // the input, the submit and `Start a different task` are all disabled. A
  // person who can type a second title during the first create is a person
  // whose second title a delayed success will wipe.
  //
  // `locked` adds `closed`: `task.create` is this form's one command, so a
  // refusal about this reader's authority closes the form rather than letting
  // it ask again, as the comment box and the propose form do.
  const { busy: creating, because, locked, run, reset } = useCommand();
  const [title, setTitle] = useState('');
  // The attempt whose outcome nobody knows. A create that ended `unavailable`
  // may well have committed on the server, so its identity and its exact
  // payload are kept here and presented again on the next submission. Minting
  // a fresh id instead would make the server's replay register unreachable and
  // the retry would create a second task.
  const [pending, setPending] = useState<PendingCreate | null>(null);

  // The same attempt while the asked-for task is the same one, a new attempt
  // when the person has changed what they are asking for. Retrying an unknown
  // outcome and deliberately starting a second task are different intentions
  // and the title is what tells them apart; `startNew` below says it outright.
  const attemptFor = (asked: string): PendingCreate =>
    pending !== null && pending.title === asked
      ? pending
      : { operationId: client.newOperationId(), title: asked };

  const onCreate = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const asked = title.trim();
    if (locked || asked === '') return;
    const attempt = attemptFor(asked);
    setPending(attempt);
    run(
      // `board: null` is explicit. The acceptance case is a task with no board,
      // and leaving the field out would let a server default decide.
      () =>
        client.mutate(
          'task.create',
          { fields: { title: attempt.title }, board: null },
          { operationId: attempt.operationId },
        ),
      (settlement) => {
        // The one case the attempt is kept for. The task may or may not exist.
        if (settlement.kind === 'unknown') return;
        // Anything else is a known outcome and the attempt is over: a refusal
        // is a decision, and holding it would resend an identity the server
        // has settled.
        setPending(null);
        if (settlement.kind !== 'ok') return;
        // Clear only the text this create was for. The input is disabled while
        // the request is in flight so there should be nothing newer, but a
        // settlement that clears whatever happens to be in the box is the same
        // defect as the task form's: a late success erasing the next task's
        // title. Bind it to what was submitted and it cannot.
        setTitle((current) => (current.trim() === attempt.title ? '' : current));
        props.onCreated();
      },
    );
  };

  /** Abandon an unresolved attempt and ask for a genuinely different task. */
  const startNew = (): void => {
    setPending(null);
    reset();
    setTitle('');
  };

  const retrying = pending !== null && pending.title === title.trim();

  return (
    <form className="taskform projects__create" onSubmit={onCreate}>
      <div className="field">
        <label className="tf__k" htmlFor="create-title">
          New task
        </label>
        <input
          id="create-title"
          className="input"
          type="text"
          required
          placeholder="What needs doing"
          disabled={locked}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
      </div>
      <button
        className="btn btn--primary"
        type="submit"
        data-attempt={retrying ? 'retry' : 'new'}
        disabled={locked || title.trim() === ''}
      >
        {creating ? 'Creating…' : retrying ? 'Retry create' : 'Create task'}
      </button>
      {pending === null ? null : (
        <button
          className="btn"
          type="button"
          data-attempt="discard"
          disabled={creating}
          onClick={startNew}
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
    </form>
  );
}
