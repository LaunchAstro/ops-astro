// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's step runner (#1624 R7): `core-agent`'s loop computing an
// accepted plan before its Launch, every call of it through the worker's one
// way to the API (`agent-call.ts`) under the work's own credential. Each turn
// is a `model.call` the broker binds and sends; each tool is the product's
// own command, so the agent's correction is the `live_correction.request` a
// person makes, `{taskId, page, word, replacement}`, at the same door and under
// the same checks. It is stored `locating`; the M5 pins its base revision
// (#1693), and nothing lands until a person decides. Nothing here opens a
// connection: the loop holds no provider, and the tools are the catalogue's
// (`AGENT_TOOLS`).

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
  isWorkerEndCode,
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

type Stop = { readonly refused: EndCode; readonly recorded: false };

/** A turn's refusal is the broker's own end code, which it records; a fault is an answer lost. */
const turnStopOf = (answer: Unanswered): Stop => ({
  refused: ('refused' in answer ? answer.refused.code : 'ANSWER_LOST') as EndCode,
  recorded: false,
});

/**
 * A read's or a tool's refusal is the attempt's stop, which `run.end` records:
 * a code the worker may end with stands, and any other (a correction the door
 * refuses, `CHANGE_ENVELOPE_EXCEEDED` among them) is `TOOL_REFUSED` (S2010-1).
 */
const stopOf = (answer: Unanswered): Stop => {
  if (!('refused' in answer)) return { refused: 'ANSWER_LOST', recorded: false };
  const { code } = answer.refused;
  return { refused: isWorkerEndCode(code) ? code : 'TOOL_REFUSED', recorded: false };
};

/** The task a read answers, under its detail as the worker's proposal reads it (`proposal.ts`). */
const taskOf = (answer: Answered): Readonly<Record<string, unknown>> | undefined =>
  answer.detail['task'] as Readonly<Record<string, unknown>> | undefined;

const revisionOf = (answer: Answered): number => Number(taskOf(answer)?.['revision']);

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
        const stop = turnStopOf(answer);
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

/**
 * The catalogue's tools, each the product's own command under the work's
 * credential. A request's operation id is the attempt's own and its place in
 * it (#1717), set over whatever the model wrote, so the same attempt asking
 * again replays and no model's id ever names an operation.
 */
function toolsOver(context: StepContext): ReadonlyMap<string, ToolRun> {
  let requests = 0;
  const read: ToolRun = async (args) => {
    const answer = await context.call('task.read', { recordId: args['taskId'] });
    if (!('body' in answer)) return stopOf(answer);
    return { revision: revisionOf(answer), content: JSON.stringify(taskOf(answer)) };
  };
  const request: ToolRun = async (args) => {
    requests += 1;
    const operationId = `correction:${context.attemptId}:${String(requests)}`;
    const answer = await context.call('live_correction.request', { ...args, operationId });
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
