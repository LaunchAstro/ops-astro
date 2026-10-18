// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's step runner (#1624 R7): `core-agent`'s loop computing an
// accepted plan before its Launch, every call of it through the worker's one
// way to the API (`agent-call.ts`) under the work's own credential. Each turn
// is a `model.call` the broker binds and sends; each tool is the product's
// own command, so the agent's correction is the `live_correction.request` a
// person makes, at the same door and under the same checks, and it stays
// `requested` until a person decides. Nothing here opens a connection: the
// loop holds no provider, and the tools are the catalogue's (`AGENT_TOOLS`).

import {
  attemptState,
  runAttempt,
  type AttemptPorts,
  type BrokerPort,
  type ToolRun,
} from '../../packages/core-agent/src/index.ts';
import {
  AGENT_MODEL_CALL_LIMIT,
  AGENT_TOOLS,
  outcomeOf,
  type EndCode,
  type RunOutcome,
  type ToolCall,
} from '../../packages/core-wire/src/index.ts';
import type { Answered, Unanswered } from './agent-call.ts';
import type { StepContext, StepEnd, StepRunner } from './step-runner.ts';

export interface AgentRunnerOptions {
  /** The catalogued turn operation each model call names. */
  readonly operation: string;
  /** The words the person's message stands for locally; the broker sends the task itself. */
  readonly task?: string;
}

/** A refusal or fault is the attempt's stop; `run.end` records it unless a stop already did. */
const stopOf = (answer: Unanswered): { readonly refused: EndCode; readonly recorded: false } => ({
  refused: ('refused' in answer ? answer.refused.code : 'ANSWER_LOST') as EndCode,
  recorded: false,
});

const revisionOf = (answer: Answered): number =>
  Number((answer.body['task'] as Readonly<Record<string, unknown>> | undefined)?.['revision']);

function brokerOver(context: StepContext, operation: string): BrokerPort {
  return {
    turn: async (turn) => {
      const answer = await context.call('model.call', {
        ...context.lease,
        operation,
        kind: 'turn',
        ...turn,
      });
      if (!('body' in answer)) {
        const stop = stopOf(answer);
        return { stopped: stop.refused, recorded: stop.recorded };
      }
      const { callId, text, toolCalls, terminal } = answer.detail;
      return {
        callId: String(callId),
        text: String(text),
        toolCalls: (toolCalls ?? []) as readonly ToolCall[],
        ...(terminal === undefined ? {} : { terminal: terminal as RunOutcome }),
      };
    },
  };
}

/** The catalogue's tools, each the product's own command under the work's credential. */
function toolsOver(context: StepContext): ReadonlyMap<string, ToolRun> {
  const read: ToolRun = async (args) => {
    const answer = await context.call('task.read', { recordId: args['taskId'] });
    if (!('body' in answer)) return stopOf(answer);
    return { revision: revisionOf(answer), content: JSON.stringify(answer.body['task']) };
  };
  const request: ToolRun = async (args) => {
    const answer = await context.call('live_correction.request', args);
    if (!('body' in answer)) return stopOf(answer);
    const correctionId = String(answer.detail['correctionId']);
    return {
      correctionId,
      content: JSON.stringify({ correctionId, state: answer.detail['state'] }),
    };
  };
  return new Map([
    ['task.read', read],
    ['live_correction.request', request],
  ]);
}

/** The runner the worker computes an accepted plan with, the agent's loop in place of the synthetic step. */
export function agentRunner(options: AgentRunnerOptions): StepRunner {
  return {
    compute: async (context): Promise<StepEnd> => {
      const first = await context.call('task.read', { recordId: context.taskId });
      if (!('body' in first)) {
        const stop = stopOf(first);
        await context.call('run.end', { ...context.lease, endCode: stop.refused });
        return { outcome: outcomeOf(stop.refused), endCode: stop.refused };
      }
      const state = attemptState(context.taskId, revisionOf(first), AGENT_TOOLS);
      const ports: AttemptPorts = {
        broker: brokerOver(context, options.operation),
        tools: toolsOver(context),
        end: async (code) => {
          await context.call('run.end', { ...context.lease, endCode: code });
        },
      };
      return await runAttempt(
        state,
        ports,
        AGENT_MODEL_CALL_LIMIT,
        undefined,
        options.task ?? 'The task.',
      );
    },
  };
}
