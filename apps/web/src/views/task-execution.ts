// SPDX-License-Identifier: AGPL-3.0-only
// One grant/task-owned execution read, shared by the task page's header,
// progress, graph and activity. The canonical pagination walk stays here.
import type { RunActivity } from '@launchastro/ui';
import {
  isRefusal,
  isUnavailable,
  type CallResult,
  type OperationsClient,
} from '../operations/client.ts';
import type {
  ExecutionEvent,
  TaskExecutionResult,
} from '../../../../packages/core-wire/src/index.ts';
import { useRead } from '../data/use-read.ts';
import { initialState, type ReadState } from '../data/authorised-read.ts';
import { isExecutionGraph } from './run-map.tsx';

export interface TaskExecutionOptions {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly taskKey: string;
  /** The owning task read’s id, when the host has one. */
  readonly taskId?: string;
  /**
   * The task read's latest answer. The page's one live channel re-reads the
   * task, and each new answer re-reads the run with it, so no second stream.
   */
  readonly readOf: unknown;
}

export type TaskExecutionRead = ReadState<TaskExecutionResult>;

/** One admitted, paginated answer for all views of this task's execution. */
export function useTaskExecution(props: TaskExecutionOptions): TaskExecutionRead {
  const read = useRead<TaskExecutionResult>({
    grantKey: props.grantKey,
    run: async () => await wholeExecution(props.client, props.taskKey, props.taskId),
    deps: [props.taskKey, props.taskId, props.readOf],
  });
  return read.own ? read.state : initialState(props.grantKey);
}

// An answer without the run list, or with a graph not whole, draws as
// unavailable, never as no run or a throw. No graph: its runs and no map.
export function isReadable(value: NonNullable<TaskExecutionResult['execution']>): boolean {
  return (
    Array.isArray(value.runs) &&
    value.runs.every(
      (run) =>
        run !== null &&
        typeof run === 'object' &&
        typeof run.runId === 'string' &&
        typeof run.state === 'string',
    ) &&
    Array.isArray(value.events) &&
    (value.graph === undefined || isExecutionGraph(value.graph))
  );
}

/**
 * Every page of `task.execution`, followed through `next` until the answer is
 * complete (a page holds at most 200 events), so event 201 is never dropped.
 * The events are joined in order; the runs and the outcome are the last
 * page's, which is the newest reading. A refusal or an outage on any page is
 * the answer, never a partial run. A `next` that does not move forward ends
 * the walk rather than asking for the same page again, and so does an answer
 * that carries no `next` at all.
 */
export async function wholeExecution(
  client: OperationsClient,
  recordId: string,
  taskId?: string,
): Promise<CallResult<TaskExecutionResult>> {
  let answer = await client.read<TaskExecutionResult>('task.execution', { recordId });
  const events: ExecutionEvent[] = [];
  let cursor = 0;
  for (;;) {
    if (isRefusal(answer) || isUnavailable(answer)) return answer;
    const page = answer.value.execution;
    if (page === undefined || !Array.isArray(page.events)) return answer;
    if (taskId !== undefined && page.taskId !== taskId) {
      return { unavailable: true, because: 'The execution answer did not name this task.' };
    }
    events.push(...page.events);
    if (page.complete === true) {
      return { ok: true, value: { execution: { ...page, events } } };
    }
    if (typeof page.next !== 'number' || !Number.isSafeInteger(page.next) || page.next <= cursor) {
      return {
        unavailable: true,
        because: 'The execution answer was incomplete and had no forward cursor.',
      };
    }
    cursor = page.next;
    // One page at a time: each asks from where the last one ended.
    // eslint-disable-next-line no-await-in-loop
    answer = await client.read<TaskExecutionResult>('task.execution', { recordId, cursor });
  }
}

/**
 * The log's rows: the execution read's events, each placed in the plan its run
 * was proposed under, and those plans, once read. A read without placements
 * draws no log rather than rows placed against nothing.
 */
export function activityOf(state: TaskExecutionRead): RunActivity | undefined {
  if (state.outcome !== 'ready' && state.outcome !== 'empty') return undefined;
  const execution = state.value.execution as Partial<TaskExecutionResult['execution']> | undefined;
  if (!Array.isArray(execution?.events) || !Array.isArray(execution.plans)) return undefined;
  if (!execution.events.every(placed)) return undefined;
  return { plans: execution.plans, events: execution.events };
}

type Placed = ExecutionEvent & { readonly placement: NonNullable<ExecutionEvent['placement']> };

const placed = (event: ExecutionEvent): event is Placed => event.placement !== undefined;
