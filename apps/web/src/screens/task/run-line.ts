// SPDX-License-Identifier: AGPL-3.0-only
import type { ProposalView, TaskExecution } from '../../../../../packages/core-wire/src/index.ts';
import { isReadable, type TaskExecutionRead } from '../../views/task-execution.ts';
import { outcomeWords, restartable } from './outcome-words.ts';

export type RunShape = 'queued' | 'running' | 'waiting' | 'finished' | 'none' | 'unknown';
interface RunLine {
  readonly shape: RunShape;
  readonly words: string;
  /** The lineage a person may restart, after a stop that was not a finish (#1719). */
  readonly restart?: string;
}
const unknown = (words = 'Run status is unavailable.'): RunLine => ({ shape: 'unknown', words });

function completedExecution(read: TaskExecutionRead, taskId: string): TaskExecution | null {
  if (read.outcome !== 'ready' && read.outcome !== 'empty') return null;
  const execution = read.value.execution;
  if (
    execution === undefined ||
    execution === null ||
    !isReadable(execution) ||
    execution.taskId !== taskId ||
    execution.complete !== true ||
    execution.next !== null ||
    !Number.isSafeInteger(execution.sourceRevision) ||
    execution.sourceRevision < 0 ||
    (execution.outcome !== 'ready' && execution.outcome !== 'no-run') ||
    (execution.outcome === 'no-run' && execution.runs.length > 0)
  )
    return null;

  return execution;
}

/** A claim about all work needs complete engine and proposal evidence. */
export function runLineOf(
  proposals: readonly ProposalView[] | undefined,
  read: TaskExecutionRead,
  taskId: string,
): RunLine {
  if (read.outcome === 'loading') return unknown('Reading run status…');
  if (read.outcome === 'denied') return unknown('The server withheld run status.');
  const execution = completedExecution(read, taskId);
  if (execution === null) return unknown();

  const states = execution.runs.map((run) => run.state);
  const unfamiliar = states.find(
    (state) =>
      !['planned', 'claimed', 'waiting_budget', 'handed_back', 'cancelled'].includes(state),
  );
  if (unfamiliar !== undefined) return unknown(`Engine run state: ${unfamiliar}`);
  const attempts = proposals
    ?.flatMap((proposal) => proposal.reservations)
    .flatMap((reservation) => (reservation.attempt === null ? [] : [reservation.attempt]));
  const running = attempts?.some((attempt) => ['reserved', 'dispatched'].includes(attempt.state));
  if (states.includes('waiting_budget'))
    return { shape: 'waiting', words: 'Engine work is awaiting budget.' };
  if (states.includes('claimed') || running === true)
    return {
      shape: 'running',
      words: running === true ? `Attempt ${attempts?.length} · running` : 'Engine work · running',
    };
  if (states.includes('planned')) return { shape: 'queued', words: 'Engine work · queued' };
  if (attempts === undefined) return unknown('Proposal run evidence was not carried.');
  const uncertain = attempts.find(
    (attempt) => !['handed_back', 'abandoned', 'settled', 'dropped'].includes(attempt.state),
  );
  if (uncertain !== undefined) return unknown(`Attempt state: ${uncertain.state}`);
  if (states.length === 0 && attempts.length === 0)
    return execution.outcome === 'no-run'
      ? { shape: 'none', words: 'No agent has run this task. It is a person’s work so far.' }
      : unknown();
  const stopped = stoppedLine(execution);
  if (stopped !== null) return stopped;
  return {
    shape: 'finished',
    words: states.includes('cancelled')
      ? 'Engine work was cancelled.'
      : states.length > 0
        ? 'Engine work was handed back.'
        : 'Every run on this task has finished.',
  };
}

/** The newest run's stop in its words (#1719), restartable unless it finished; null without one. */
function stoppedLine(execution: TaskExecution): RunLine | null {
  const newest = execution.runs.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const stop = newest?.runOutcome ?? null;
  if (newest === undefined || stop === null) return null;
  return {
    shape: 'finished',
    words: outcomeWords(stop),
    ...(restartable(stop) ? { restart: newest.lineageId } : {}),
  };
}
