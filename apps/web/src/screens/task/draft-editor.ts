// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import type { Prefill } from './task-prefill.ts';
import {
  dropDraft,
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
/** The draft as kept for the person: read once, and written on every change (DN-04). */
export function useKeptDraft(props: DraftEditorProps) {
  const { storage, person } = props;
  const [draft, setDraft] = useState<TaskDraft>(
    () =>
      readDraft(storage, person) ?? {
        ...(props.scope.prefill === undefined
          ? emptyDraft(props.scope.clientId)
          : prefilledDraft(props.scope.prefill)),
        from: props.scope.from,
      },
  );
  // The create's identity, kept across an unknown outcome and a remount, and
  // dropped by any edit.
  const [attempt, setAttempt] = useState<Attempt | null>(() => readAttempt(storage, person));
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
  // Stored before Create goes out, with each part's id and count as it goes;
  // cleared once its outcome is known.
  const begin = (next: Attempt, sent: TaskDraft = draft): void => {
    setAttempt(next);
    keepDraft(storage, person, sent, next);
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
    dropDraft(storage, person);
    props.onClose();
  };
  // A Create another mount sent has answered: its identity is as it left it.
  const reread = (): void => {
    setAttempt(readAttempt(storage, person));
  };
  return { draft, put, name, attempt, begin, progress, settled, cancel, reread };
}
