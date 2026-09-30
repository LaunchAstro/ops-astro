// SPDX-License-Identifier: AGPL-3.0-only
//
// The new-task draft in the dock task panel (MP-4-13, CS-4.36, CS-4.37;
// DN-01, DN-03 to DN-05): the fields (`DraftFields.tsx`) kept for this person
// until Create or Cancel, and the Create that writes them (`task-draft.ts`).
//
// **Create or Cancel end it; nothing else does.** X and Escape close the panel
// and keep the draft; Cancel discards it on purpose; Create writes it and
// opens the new task in the panel. An empty name is refused with the field
// focused, and nothing is sent.
//
// **One create, however many presses.** An outcome nobody knows keeps the
// create's identity for the retry, so the server's replay answers it rather
// than a second task; an edit to the draft is a different request and starts
// a new one.
//
// **Timer on the draft.** DN-05's running timer on a draft waits on the dock
// frame's timer (MP-3-1); time spent is logged here and written at Create.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import { DraftFields } from './DraftFields.tsx';
import {
  createFromDraft,
  dropDraft,
  emptyDraft,
  keepDraft,
  readDraft,
  type TaskDraft,
} from './task-draft.ts';

/** Where the draft was filed from: the page's client, if it has one, and its name for the admission line. */
export interface DraftScope {
  readonly clientId: string | null;
  readonly from: string;
}

export interface DraftPanelProps {
  readonly client: OperationsClient;
  readonly storage: Storage | null;
  /** The draft's owner, `business:person`: the storage key, never shared. */
  readonly person: string;
  readonly scope: DraftScope;
  readonly onCreated: (key: string) => void;
  readonly onClose: () => void;
}

const CONTROLS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

export function DraftPanel(props: DraftPanelProps): ReactElement {
  const kept = useKeptDraft(props);
  const creating = useCreate(props, kept);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (CONTROLS.has((event.target as HTMLElement).tagName)) return;
    event.preventDefault();
    props.onClose();
  };
  return (
    <aside className="dtp" data-draft-panel aria-label="New task" onKeyDown={onKeyDown}>
      {creating.missed === null ? (
        <DraftBody {...props} kept={kept} creating={creating} />
      ) : (
        <Missed {...creating.missed} onOpen={props.onCreated} />
      )}
    </aside>
  );
}

type Kept = ReturnType<typeof useKeptDraft>;
type Creating = ReturnType<typeof useCreate>;

function DraftBody(
  props: DraftPanelProps & { readonly kept: Kept; readonly creating: Creating },
): ReactElement {
  const { kept, creating } = props;
  return (
    <>
      <div className="dtp__head">
        <h2 className="t-title">New task</h2>
        <button className="btn" type="button" data-draft="close" onClick={props.onClose}>
          Close
        </button>
      </div>
      <p className="card__sub" data-draft-admission>
        New task, filed from {props.scope.from}. Nothing is stored until Create.
      </p>
      <DraftFields draft={kept.draft} put={kept.put} name={kept.name} />
      {creating.refusal === null ? null : (
        <p className="field__error" role="alert" data-draft-refusal>
          {creating.refusal}
        </p>
      )}
      <div className="dtp__head">
        <button
          className="btn btn--primary"
          type="button"
          data-draft="create"
          disabled={creating.busy}
          onClick={() => {
            void creating.create();
          }}
        >
          Create task
        </button>
        <button className="btn" type="button" data-draft="cancel" onClick={kept.cancel}>
          Cancel
        </button>
      </div>
    </>
  );
}

/** The draft as kept for the person: read once, and written on every change (DN-04). */
function useKeptDraft(props: DraftPanelProps) {
  const { storage, person } = props;
  const [draft, setDraft] = useState<TaskDraft>(
    () => readDraft(storage, person) ?? emptyDraft(props.scope.clientId),
  );
  // The create's identity, kept across an unknown outcome and dropped by any edit.
  const [attempt, setAttempt] = useState<string | null>(null);
  const name = useRef<HTMLInputElement>(null);
  useEffect(() => {
    name.current?.focus();
  }, []);
  const put = (next: Partial<TaskDraft>): void => {
    const merged = { ...draft, ...next };
    setDraft(merged);
    setAttempt(null);
    keepDraft(storage, person, merged);
  };
  const cancel = (): void => {
    dropDraft(storage, person);
    props.onClose();
  };
  return { draft, put, name, attempt, setAttempt, cancel };
}

/** Create: the refusal for an empty name, the one identity per attempt, and the parts not written. */
function useCreate(props: DraftPanelProps, kept: Kept) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [missed, setMissed] = useState<{ taskKey: string; parts: readonly string[] } | null>(null);
  const create = async (): Promise<void> => {
    if (busy) return;
    if (kept.draft.title.trim() === '') {
      setRefusal('Name the new task first.');
      kept.name.current?.focus();
      return;
    }
    const operationId = kept.attempt ?? props.client.newOperationId();
    kept.setAttempt(operationId);
    setBusy(true);
    setRefusal(null);
    const outcome = await createFromDraft(props.client, kept.draft, operationId);
    setBusy(false);
    if (outcome.kind !== 'unknown') kept.setAttempt(null);
    if (outcome.kind !== 'created') {
      setRefusal(outcome.because);
      return;
    }
    dropDraft(props.storage, props.person);
    if (outcome.missed.length === 0) props.onCreated(outcome.key);
    else setMissed({ taskKey: outcome.key, parts: outcome.missed });
  };
  return { busy, refusal, missed, create };
}

/** A task created with parts refused after it: named, and a door to the task (never a second create). */
function Missed(props: {
  readonly taskKey: string;
  readonly parts: readonly string[];
  readonly onOpen: (key: string) => void;
}): ReactElement {
  return (
    <>
      <p className="card__sub" role="status" data-draft-missed>
        Created {props.taskKey}; not added: {props.parts.join(', ')}. Add them on the task.
      </p>
      <button
        className="btn btn--primary"
        type="button"
        data-draft="open-created"
        onClick={() => {
          props.onOpen(props.taskKey);
        }}
      >
        Open the task
      </button>
    </>
  );
}
