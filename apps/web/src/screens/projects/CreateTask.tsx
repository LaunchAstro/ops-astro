// SPDX-License-Identifier: AGPL-3.0-only
import { useLayoutEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { Icon } from '@launchastro/ui';
import type { OperationsClient } from '../../operations/client.ts';
import type { Failure } from '../../records/use-command.ts';
import { useCreates } from '../task/create-context.tsx';
import type { CreateCustody, CreateHold } from '../task/create-custody.ts';
interface Draft {
  readonly of: CreateCustody;
  readonly id: string;
  readonly generation: number;
  readonly title: string;
  readonly picked: string | null;
  readonly failure: Failure | null;
}
const empty = (of: CreateCustody): Draft => ({
  of,
  id: crypto.randomUUID(),
  generation: 0,
  title: '',
  picked: null,
  failure: null,
});
function useCreateDraft(custody: CreateCustody, onCreated: () => void) {
  const [held, setHeld] = useState(() => empty(custody));
  const draft = held.of === custody ? held : empty(custody);
  const live = useRef(custody);
  live.current = custody;
  const mounted = useRef(false);
  const own = (edit: (draft: Draft) => Draft): void => {
    setHeld((before) => edit(before.of === custody ? before : empty(custody)));
  };
  useLayoutEffect(() => {
    mounted.current = true;
    let active = true;
    const stop = custody.created((editor) => {
      if (!active || live.current !== custody) return;
      setHeld((before) =>
        before.of === custody && before.id === editor.id && before.generation === editor.generation
          ? { ...before, title: '', generation: before.generation + 1 }
          : before,
      );
      onCreated();
    });
    return () => {
      active = false;
      mounted.current = false;
      stop();
    };
  }, [custody, onCreated]);
  return { draft, own, live, mounted };
}
function matches(hold: CreateHold | undefined, draft: Draft): boolean {
  return (
    hold !== undefined &&
    hold.entry.knowledge.kind !== 'answered' &&
    hold.entry.editor.id === draft.id &&
    hold.entry.editor.generation === draft.generation &&
    hold.entry.body.fields.title === draft.title.trim()
  );
}
function startNewDraft(before: Draft): Draft {
  return { ...before, title: '', generation: before.generation + 1, picked: null, failure: null };
}
function useCreateTask(client: OperationsClient, onCreated: () => void) {
  const { custody, state } = useCreates(client);
  const { draft, own, live, mounted } = useCreateDraft(custody, onCreated);
  const pending = draft.picked === null ? undefined : state.holds.get(draft.picked);
  const busy = pending?.busy ?? false;
  const closed = draft.failure?.kind === 'closed' && pending?.entry.knowledge.kind !== 'unresolved';
  const locked = busy || closed || state.problem !== null;
  const cleanupBlocked = [...state.holds.values()].some(
    (hold) => hold.entry.knowledge.kind === 'answered' && !hold.kept,
  );
  const retry = (id: string): void => {
    void custody.retry(id).then((answer) => {
      if (!mounted.current || live.current !== custody || answer === undefined) return null;
      own((before) =>
        before.picked === id
          ? { ...before, failure: answer.kind === 'ok' ? null : answer }
          : before,
      );
      return null;
    });
  };
  const onCreate = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const title = draft.title.trim();
    if (locked || cleanupBlocked || title === '') return;
    const id = matches(pending, draft)
      ? pending!.entry.operationId
      : custody.prepare(title, { id: draft.id, generation: draft.generation });
    if (id === null) return;
    own((before) => ({ ...before, picked: id, failure: null }));
    retry(id);
  };
  return {
    custody,
    state,
    draft,
    pending,
    busy,
    locked,
    cleanupBlocked,
    retry,
    onCreate,
    setTitle: (title: string) =>
      own((before) => ({ ...before, title, generation: before.generation + 1 })),
    startNew: () => own(startNewDraft),
  };
}
export function CreateTask(props: {
  readonly client: OperationsClient;
  readonly onCreated: () => void;
}): ReactElement {
  const form = useCreateTask(props.client, props.onCreated);
  const { draft, pending } = form;
  const retrying = matches(pending, draft);
  const failure = pending?.failure ?? draft.failure;
  return (
    <form className="projects__create" onSubmit={form.onCreate}>
      <CreateFields form={form} retrying={retrying} />
      {failure === null ? null : (
        <p className="field__error" role="alert">
          {failure.because}
        </p>
      )}
      {pending?.entry.knowledge.kind !== 'unresolved' || failure === null ? null : (
        <p className="card__sub" data-attempt="unresolved">
          This task may already have been created. Retrying sends the same attempt.
        </p>
      )}
      {form.state.problem === null ? null : <p role="alert">{form.state.problem}</p>}
      {[...form.state.holds].map(([id, hold], index) => (
        <HeldCreate
          key={id}
          id={id}
          hold={hold}
          number={index + 1}
          onRetry={() => form.retry(id)}
          onCleanup={() => form.custody.cleanup(id)}
        />
      ))}
    </form>
  );
}
function HeldCreate(props: {
  readonly id: string;
  readonly hold: CreateHold;
  readonly number: number;
  readonly onRetry: () => void;
  readonly onCleanup: () => void;
}): ReactElement {
  const { hold, id } = props;
  return hold.entry.knowledge.kind === 'answered' ? (
    <span>
      <span role="alert">The recovery copy could not be cleared.</span>
      <button
        className="btn btn--sm"
        type="button"
        data-create-cleanup={id}
        onClick={props.onCleanup}
      >
        Retry cleanup
      </button>
    </span>
  ) : (
    <span>
      <button
        className="btn btn--sm"
        type="button"
        data-create-retry={id}
        disabled={hold.busy}
        onClick={props.onRetry}
      >
        Retry task creation {props.number}
      </button>
      {hold.failure === null ? null : <span role="alert">{hold.failure.because}</span>}
    </span>
  );
}

function CreateFields({
  form,
  retrying,
}: {
  readonly form: ReturnType<typeof useCreateTask>;
  readonly retrying: boolean;
}): ReactElement {
  return (
    <>
      <label className="visually-hidden" htmlFor="create-title">
        New task
      </label>
      <span className="cbd__field">
        <Icon name="plus" size="xs" />
        <input
          id="create-title"
          type="text"
          required
          placeholder="Add a task…"
          disabled={form.locked}
          value={form.draft.title}
          onChange={(event) => form.setTitle(event.target.value)}
        />
      </span>
      <button
        className="btn btn--secondary btn--sm"
        type="submit"
        data-attempt={retrying ? 'retry' : 'new'}
        disabled={form.locked || form.cleanupBlocked}
      >
        {form.busy ? 'Creating…' : retrying ? 'Retry create' : 'Create task'}
      </button>
      {form.pending === undefined || form.pending.entry.knowledge.kind === 'answered' ? null : (
        <button
          className="btn btn--sm"
          type="button"
          data-attempt="discard"
          disabled={form.busy}
          onClick={form.startNew}
        >
          Start a different task
        </button>
      )}
    </>
  );
}
