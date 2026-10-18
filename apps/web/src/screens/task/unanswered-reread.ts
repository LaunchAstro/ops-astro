// SPDX-License-Identifier: AGPL-3.0-only
//
// #1710: the server judges a launched run `unanswered` once it has waited its
// bound with no runner taking it, but only when the task is read, and passing
// the bound writes nothing, so a quiet live stream never brings the read. An
// open task therefore reads itself again when a waiting run's bound passes,
// and the server's answer stands. Should this clock run ahead of the
// server's, the run still reads waiting, and it asks again a minute later.

import { useEffect } from 'react';
import type { ReadState } from '../../data/authorised-read.ts';
import type { TaskReadResult, TaskRunView } from '../../../../../packages/core-wire/src/index.ts';

/** The server's bound (`UNANSWERED_MINUTES`, core-records `launches.ts`), in milliseconds. */
export const UNANSWERED_MS = 15 * 60_000;
/** Past the bound, so the server's statement reads it passed. */
const SLACK_MS = 2_000;
/** Asking again when this clock said the bound passed and the server did not. */
const AGAIN_MS = 60_000;

/** The task's open run in the answer on screen, if any. */
const runOf = (state: ReadState<TaskReadResult>): TaskRunView | null =>
  state.outcome === 'ready' && 'task' in state.value && 'agent' in state.value.task
    ? (state.value.task.agent?.run ?? null)
    : null;

/** Read the task again once its waiting run's bound has passed. */
export function useUnansweredReread(state: ReadState<TaskReadResult>, reread: () => void): void {
  const run = runOf(state);
  const due = run?.state === 'waiting' ? Date.parse(run.launchedAt) + UNANSWERED_MS : null;
  useEffect(() => {
    if (due === null) return;
    const left = due - Date.now();
    const timer = setTimeout(reread, left > 0 ? left + SLACK_MS : AGAIN_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [due, run, reread]);
}
