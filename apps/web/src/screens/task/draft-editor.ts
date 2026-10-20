// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { adoptFormerCreate } from './former-create.ts';
import type { Prefill } from './task-prefill.ts';
import {
  discardDraft,
  emptyDraft,
  keepDraft,
  prefilledDraft,
  readAttempt,
  readDraft,
  saveAttempt,
  type Attempt,
  type TaskDraft,
} from './task-draft.ts';
/** Where the draft was filed from: the page's client, if it has one, and its name for the admission line. */
export interface DraftScope {
  readonly clientId: string | null;
  readonly from: string;
  /** The page's guesses for a fresh draft (DN-02); a kept draft comes back as left. */
  readonly prefill?: Prefill;
}

export interface DraftEditorProps {
  readonly storage: Storage | null;
  readonly person: string;
  readonly scope: DraftScope;
  readonly onClose: () => void;
}
/** An unnamed kept draft given the door's name goes where the door is: its client and project. */
function namedAtDoor(kept: TaskDraft, door: Prefill, from: string): TaskDraft {
  const { title, clientId, boardId } = door;
  if (kept.clientId === clientId && kept.boardId === boardId) return { ...kept, title };
  // Its guesses were made on another page, so they are not claimed for this one.
  return { ...kept, title, clientId, boardId, from, why: null };
}

/** The kept draft as left, given the door's typed name if it has none; else a fresh one. */
function openedDraft(props: DraftEditorProps): TaskDraft {
  adoptFormerCreate(props.storage, props.person);
  const kept = readDraft(props.storage, props.person);
  const door = props.scope.prefill;
  if (kept !== null)
    return kept.title.trim() === '' && door !== undefined && door.title !== ''
      ? namedAtDoor(kept, door, props.scope.from)
      : kept;
  const fresh =
    props.scope.prefill === undefined
      ? emptyDraft(props.scope.clientId)
      : prefilledDraft(props.scope.prefill);
  return { ...fresh, from: props.scope.from };
}

/** The draft as kept for the person: read once, and written on every change (DN-04). */
export function useKeptDraft(props: DraftEditorProps) {
  const { storage, person } = props;
  const typed = props.scope.prefill?.title ?? '';
  const [draft, setDraft] = useState<TaskDraft>(() => openedDraft(props));
  // The create's identity, kept across an unknown outcome and a remount until
  // its own retry settles it or Cancel drops the draft.
  const [attempt, setAttempt] = useState<Attempt | null>(() => readAttempt(storage, person));
  const name = useRef<HTMLInputElement>(null);
  useEffect(() => {
    name.current?.focus();
    // A name typed at the door is kept like any edit.
    if (typed !== '' && draft.title === typed && attempt === null)
      keepDraft(storage, person, draft);
  }, []);
  const put = (next: Partial<TaskDraft>): void => {
    // A Create with no answer yet holds the draft as it sent it (U112).
    if (attempt !== null) return;
    const merged = { ...draft, ...next };
    setDraft(merged);
    setAttempt(null);
    keepDraft(storage, person, merged);
  };
  // Stored before Create goes out, with each part's id and count as it goes;
  // cleared once its outcome is known. A new attempt storage would not keep is
  // not taken up, so a reload cannot bring back the draft without it.
  const begin = (next: Attempt, sent: TaskDraft = draft): boolean => {
    const taken = keepDraft(storage, person, sent, next) || attempt !== null;
    if (taken) setAttempt(next);
    else keepDraft(storage, person, sent);
    return taken;
  };
  const progress = (next: Attempt): void => {
    setAttempt((held) => (held?.id === next.id ? next : held));
    saveAttempt(storage, person, next.id, next);
  };
  const settled = (id: string): void => {
    setAttempt(null);
    saveAttempt(storage, person, id, null);
  };
  const cancel = (): void => {
    discardDraft(storage, person);
    props.onClose();
  };
  // A Create another mount sent has answered: its identity is as it left it.
  const reread = (): void => {
    setAttempt(readAttempt(storage, person));
  };
  return { draft, put, name, attempt, begin, progress, settled, cancel, reread };
}
