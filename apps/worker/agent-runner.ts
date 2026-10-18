// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent step runner (#1623 R4): `core-agent`'s loop as the worker's
// `StepRunner`. Its ports are the worker's agent calls under the plan's lease:
// a broker turn is `model.call`, the task's read is `task.read` and the run's
// own stop is `run.end`. Injected by its own tests; wired by #1624.
//
// A refusal the broker or the door answers is the server's: the stop that
// refused it recorded the outcome. An answer that never came is the worker's
// to end (`ANSWER_LOST`); the server records it only once its records show
// the call settled.

import {
  attemptState,
  runAttempt,
  type AttemptPorts,
  type TurnAnswer,
} from '../../packages/core-agent/src/index.ts';
import {
  AGENT_MODEL_CALL_LIMIT,
  outcomeOf,
  type EndCode,
  type ToolCall,
} from '../../packages/core-wire/src/index.ts';
import type { Answered, Unanswered } from './agent-call.ts';
import type { StepContext, StepEnd, StepRunner } from './step-runner.ts';

export interface AgentRunnerOptions {
  /** The broker's turn operation for the route this run is on. */
  readonly operation: string;
  readonly limit?: number;
}

const CATALOGUE: readonly string[] = ['task.read'];

/** Door refusals that mean the work is no longer this worker's: their stop is recorded. */
const LOST: ReadonlySet<string> = new Set(['LEASE_EXPIRED', 'LEASE_NOT_OWNED', 'AUTHORITY_LOST']);

const refusedCode = (answer: Unanswered): { stopped: EndCode; recorded: boolean } =>
  'refused' in answer
    ? { stopped: answer.refused.code as EndCode, recorded: true }
    : { stopped: 'ANSWER_LOST', recorded: false };

export function agentRunner(options: AgentRunnerOptions): StepRunner {
  const limit = options.limit ?? AGENT_MODEL_CALL_LIMIT;
  return {
    compute: async (context: StepContext): Promise<StepEnd> => {
      const { call, lease, taskId } = context;
      const read = await call('task.read', { recordId: taskId });
      if (!('body' in read)) return await ended(context, refusedCode(read));
      const state = attemptState(taskId, Number(read.detail['revision']), CATALOGUE);
      const ports: AttemptPorts = {
        broker: {
          turn: async (turn): Promise<TurnAnswer> => {
            const answer = await call('model.call', {
              leaseId: lease.leaseId,
              fence: lease.fence,
              operation: options.operation,
              kind: 'turn',
              ...turn,
            });
            if (!('body' in answer)) return refusedCode(answer);
            return answerOf(answer);
          },
        },
        tools: new Map([
          [
            'task.read',
            async () => {
              const again = await call('task.read', { recordId: taskId });
              if (!('body' in again)) {
                const { stopped } = refusedCode(again);
                return LOST.has(stopped)
                  ? { refused: stopped, recorded: true }
                  : { refused: 'TOOL_REFUSED', recorded: false };
              }
              return { revision: Number(again.detail['revision']), content: 'read' };
            },
          ],
        ]),
        end: async (endCode) => {
          await call('run.end', { leaseId: lease.leaseId, fence: lease.fence, endCode });
        },
      };
      return await runAttempt(state, ports, limit, undefined, 'The task.');
    },
  };
}

/** A settled turn's words and tool calls, or the stop the broker answered instead. */
function answerOf(answer: Answered): TurnAnswer {
  const { detail } = answer;
  if (detail['state'] !== 'settled') {
    const code = typeof detail['code'] === 'string' ? detail['code'] : 'ANSWER_LOST';
    return { stopped: code as EndCode, recorded: code !== 'ANSWER_LOST' };
  }
  return {
    callId: String(detail['callId']),
    text: String(detail['text']),
    toolCalls: (detail['toolCalls'] ?? []) as readonly ToolCall[],
    ...(detail['terminal'] === undefined ? {} : { terminal: detail['terminal'] as 'call_limit' }),
  };
}

async function ended(
  context: StepContext,
  stop: { stopped: EndCode; recorded: boolean },
): Promise<StepEnd> {
  if (!stop.recorded) {
    await context.call('run.end', {
      leaseId: context.lease.leaseId,
      fence: context.lease.fence,
      endCode: stop.stopped,
    });
  }
  return { outcome: outcomeOf(stop.stopped), endCode: stop.stopped };
}
