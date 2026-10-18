// SPDX-License-Identifier: AGPL-3.0-only
//
// #1710: the server judges a launched run `unanswered` once it has waited its
// bound with no runner taking it, but only when the task is read, and passing
// the bound writes nothing, so a quiet live stream never brings the read. An
// open task therefore reads itself again when a waiting run's bound passes,
// and the server's answer stands. The read says how long the bound had left
// by the server's clock (`boundLeftMs`), and this counts it from when that
// answer arrived, so a browser clock ahead of or behind the server's moves
// nothing.

import { useEffect, useRef } from 'react';
import type { ReadState } from '../../data/authorised-read.ts';
import type { TaskReadResult, TaskRunView } from '../../../../../packages/core-wire/src/index.ts';

/** Past the bound, so the server's statement reads it passed. */
const SLACK_MS = 2_000;
/** Asking again when the server answers a run waiting with no time left. */
const AGAIN_MS = 60_000;

/** The task's open run in the answer on screen, if any. */
const runOf = (state: ReadState<TaskReadResult>): TaskRunView | null =>
  state.outcome === 'ready' && 'task' in state.value && 'agent' in state.value.task
    ? (state.value.task.agent?.run ?? null)
    : null;

/** Read the task again once its waiting run's bound has passed. */
export function useUnansweredReread(state: ReadState<TaskReadResult>, reread: () => void): void {
  const run = runOf(state);
  // Each answer is a new `run`; when it arrived, on this page's monotonic clock.
  const arrived = useRef<{ run: TaskRunView | null; at: number }>({ run: null, at: 0 });
  useEffect(() => {
    if (run?.state !== 'waiting') return;
    if (arrived.current.run !== run) arrived.current = { run, at: performance.now() };
    const left = arrived.current.at + run.boundLeftMs - performance.now();
    const timer = setTimeout(reread, run.boundLeftMs > 0 ? Math.max(0, left) + SLACK_MS : AGAIN_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [run, reread]);
}
