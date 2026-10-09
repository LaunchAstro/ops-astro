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
// a new one. The identity is stored with the draft before Create goes out, so
// a reload or Back while it is out reopens the draft with it. While Create is
// out, the fields, Close, Cancel, Escape and the host's doors wait for it, so
// the draft is never changed under it, reopened or created again; a Create
// that lands after the session changed opens nothing. A close the dock refused
// has already taken the panel out and put it back, which mounts the draft
// again: the new mount finds the Create still out (`flights`) and waits too.
//
// **Timer on the draft (DN-05).** The draft's own timer (`DraftTimer.tsx`) is
// kept with it; Create stops a running one first, so its minutes go with the
// task as a new request, and they are written with the time typed here.

import { useLayoutEffect, useState, type KeyboardEvent, type ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import { DraftFields, Missed } from './DraftFields.tsx';
import { useKeptDraft, type DraftEditorProps } from './draft-editor.ts';
export type { DraftScope } from './draft-editor.ts';
import { draftProblem, dropDraft, newAttempt, stopTimer, type Attempt } from './task-draft.ts';
import { createFromDraft, type CreateOutcome } from './draft-parts.ts';

export interface DraftPanelProps extends DraftEditorProps {
  readonly client: OperationsClient;
  readonly onCreated: (key: string) => void;
  /** Drawn by the dock, whose X closes it: the head draws no Close of its own. */
  readonly docked?: boolean;
  /** Hold the host while Create is out; the release says whether the session is still the same. */
  readonly hold: () => () => boolean;
}

const CONTROLS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

/** What a Create's answer leaves on the draft's screen. */
interface Settled {
  readonly refusal: string | null;
  readonly missed: { readonly taskKey: string; readonly parts: readonly string[] } | null;
}

/** Each host's Create still out, by the hold it took; the draft's latest mount shows its answer. */
const flights = new WeakMap<
  DraftPanelProps['hold'],
  { readonly person: string; show: (settled: Settled) => void }
>();

export function DraftPanel(props: DraftPanelProps): ReactElement {
  const kept = useKeptDraft(props);
  const creating = useCreate(props, kept);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented || creating.busy) return;
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
      <DraftHead busy={creating.busy} docked={props.docked === true} onClose={props.onClose} />
      <p className="card__sub" data-draft-admission>
        New task, filed from {kept.draft.from ?? props.scope.from}.{' '}
        {kept.draft.why === null ? '' : `${kept.draft.why} `}
        Nothing is stored until Create.
      </p>
      <DraftFields draft={kept.draft} put={kept.put} name={kept.name} locked={creating.busy} />
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
        <button
          className="btn"
          type="button"
          data-draft="cancel"
          disabled={creating.busy}
          onClick={kept.cancel}
        >
          Cancel
        </button>
      </div>
    </>
  );
}

/**
 * The draft's title and Close; Close waits while Create is out. Drawn by the
 * dock, whose X closes it, the head draws no Close of its own.
 */
function DraftHead(props: {
  readonly busy: boolean;
  readonly docked: boolean;
  readonly onClose: () => void;
}): ReactElement {
  return (
    <div className="dtp__head">
      <h2 className="t-title">New task</h2>
      {props.docked ? null : (
        <button
          className="btn"
          type="button"
          data-draft="close"
          disabled={props.busy}
          onClick={props.onClose}
        >
          Close
        </button>
      )}
    </div>
  );
}

/** A Create's answer: its identity settled; once created, the draft dropped and the task opened. */
function land(props: DraftPanelProps, kept: Kept, outcome: CreateOutcome, at: Attempt): Settled {
  if (outcome.kind !== 'unknown') kept.settled(at.id);
  if (outcome.kind !== 'created') return { refusal: outcome.because, missed: null };
  dropDraft(props.storage, props.person);
  if (outcome.missed.length > 0) {
    return { refusal: null, missed: { taskKey: outcome.key, parts: outcome.missed } };
  }
  props.onCreated(outcome.key);
  return { refusal: null, missed: null };
}

function createRefusal(props: DraftPanelProps, kept: Kept): string | null {
  const problem = draftProblem(props.storage, props.person);
  if (problem !== null) return problem;
  if (kept.draft.title.trim() !== '') return null;
  kept.name.current?.focus();
  return 'Name the new task first.';
}

function useCreate(props: DraftPanelProps, kept: Kept) {
  const [view, setView] = useState<Settled & { readonly busy: boolean }>(() => ({
    busy: flights.get(props.hold)?.person === props.person,
    refusal: null,
    missed: null,
  }));
  const show = (settled: Settled): void => {
    setView({ busy: false, ...settled });
  };
  // A Create another mount sent is still out: its answer is shown here.
  useLayoutEffect(() => {
    const out = flights.get(props.hold);
    if (out?.person !== props.person) return;
    out.show = (settled) => {
      kept.reread();
      show(settled);
    };
  }, []);
  const create = async (): Promise<void> => {
    if (view.busy) return;
    const refusal = createRefusal(props, kept);
    if (refusal !== null) {
      setView((last) => ({ ...last, refusal }));
      return;
    }
    // A running timer stops at Create: its minutes go with the task (DN-05), a new request.
    const sent = stopTimer(kept.draft, Date.now());
    if (sent !== kept.draft) kept.put(sent);
    const held = sent === kept.draft ? kept.attempt : null;
    const attempt = held ?? newAttempt(props.client.newOperationId());
    kept.begin(attempt, sent);
    const release = props.hold();
    const flight = { person: props.person, show };
    flights.set(props.hold, flight);
    setView({ busy: true, refusal: null, missed: null });
    let outcome: CreateOutcome | null = null;
    try {
      outcome = await createFromDraft(props.client, sent, attempt, kept.progress, held !== null);
    } finally {
      // The session changed while it was out: the draft and the panel went with it.
      if (!release()) outcome = null;
      if (flights.get(props.hold) === flight) flights.delete(props.hold);
    }
    if (outcome !== null) flight.show(land(props, kept, outcome, attempt));
  };
  return { ...view, create };
}
