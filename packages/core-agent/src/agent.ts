// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent loop on the pinned stack (#1623 R4): LangChain's `createAgent`
// over LangGraph, with `MemorySaver` only, its model the broker's
// (`model.ts`) and its tools the catalogue's. Its only middleware are the two
// call limits, each set to the server's limit and to raise: their defaults
// end or carry on, which reads as a normal finish. The server's limit is the
// authority (design R4); these stop early only. No caller's `context` is ever
// passed in, since it can lift both limits.
//
// `runAttempt` computes one attempt in a fresh store (`guard.ts`) and ends it
// in exactly one named outcome. Only a final answer with no stop is success.

import { MemorySaver } from '@langchain/langgraph';
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { createAgent, modelCallLimitMiddleware, toolCallLimitMiddleware } from 'langchain';
import { outcomeOf, type EndCode, type RunOutcome } from '../../core-wire/src/index.ts';
import { isolated, runRefused } from './guard.ts';
import { OpsAstroChatModel, type BrokerPort } from './model.ts';
import { RunEnd, type AttemptState } from './turn.ts';

/** A tool's own call through the product, under the attempt's credential. */
export type ToolRun = (
  args: Readonly<Record<string, unknown>>,
) => Promise<
  | { readonly revision: number; readonly content: string }
  | { readonly refused: EndCode; readonly recorded: boolean }
>;

export interface AttemptPorts {
  readonly broker: BrokerPort;
  /** Each catalogue tool, by name. */
  readonly tools: ReadonlyMap<string, ToolRun>;
  /** The run's own stop, for an end only the worker sees. */
  readonly end: (code: EndCode) => Promise<void>;
}

export interface AttemptEnd {
  readonly outcome: RunOutcome;
  readonly endCode: EndCode;
}

const LIMIT_ERRORS: ReadonlySet<string> = new Set([
  'ModelCallLimitMiddlewareError',
  'ToolCallLimitExceededError',
]);

/** The tools the graph is given: each runs through the product and records its read. */
function toolsOf(state: AttemptState, ports: AttemptPorts): StructuredToolInterface[] {
  return state.catalogue.map(
    (name): StructuredToolInterface =>
      tool(
        async (args: Record<string, unknown>, config: { toolCall?: { id?: string } }) => {
          const run = ports.tools.get(name);
          const read =
            run === undefined
              ? { refused: 'TOOL_NOT_CATALOGUED' as const, recorded: false }
              : await run(args);
          // The refusal's own code is the stop: a lost lease is not a refused tool.
          if ('refused' in read) {
            state.ended ??= new RunEnd(read.refused, read.recorded);
            throw state.ended;
          }
          state.reads.set(String(config.toolCall?.id), read.revision);
          return read.content;
        },
        { name, description: `The ${name} operation`, schema: { type: 'object' } },
      ) as StructuredToolInterface,
  );
}

/** The compiled agent, as this package uses it. */
export interface OpsAstroAgent {
  readonly invoke: (
    input: { readonly messages: readonly BaseMessage[] },
    config: { readonly configurable: { readonly thread_id: string } },
  ) => Promise<{ readonly messages: readonly BaseMessage[] }>;
}

type Middleware = NonNullable<Parameters<typeof createAgent>[0]['middleware']>;
type ModelLimit = Parameters<typeof modelCallLimitMiddleware>[0];
type ToolLimit = Parameters<typeof toolCallLimitMiddleware>[0];

/**
 * The two limits, each the server's and each raising. Their option and
 * middleware types are inferred through LangChain's zod interop, which
 * collapses under this repository's `exactOptionalPropertyTypes`; the casts
 * are only that. A limit that ended instead of raising would read as
 * success, which `an-agent-at-the-call-limit-ends-call-limit-and-never-reads-as-a-draft.test.ts`
 * refuses.
 */
const limits = (limit: number): Middleware =>
  [
    modelCallLimitMiddleware({ runLimit: limit, exitBehavior: 'error' } as unknown as ModelLimit),
    toolCallLimitMiddleware({ runLimit: limit, exitBehavior: 'error' } as unknown as ToolLimit),
  ] as unknown as Middleware;

/** The agent for one attempt. Its model and every binding share `state`. */
export function createOpsAstroAgent(
  state: AttemptState,
  ports: AttemptPorts,
  limit: number,
): OpsAstroAgent {
  if (runRefused(process.env)) throw new RunEnd('TRACING_NOT_ALLOWED', false);
  return createAgent({
    model: new OpsAstroChatModel(ports.broker, state),
    tools: toolsOf(state, ports),
    checkpointer: new MemorySaver(),
    middleware: limits(limit),
  }) as unknown as OpsAstroAgent;
}

/** The stop a thrown error is: the run's own, a local limit, or an answer that never came. */
function stopOf(state: AttemptState, error: unknown): RunEnd {
  if (state.ended !== undefined) return state.ended;
  if (error instanceof RunEnd) return error;
  const name = (error as { name?: unknown } | undefined)?.name;
  // A local limit stop is not success. The server's equal limit records
  // `call_limit` at the limit-th settlement, so a local one firing first is a
  // turn past its bound: one answer asking for more tools than the limit.
  if (typeof name === 'string' && LIMIT_ERRORS.has(name))
    return new RunEnd('TURN_MALFORMED', false);
  return new RunEnd('ANSWER_LOST', false);
}

/**
 * One attempt, computed in a fresh store, to its one outcome. A stop the
 * server already recorded is returned as it is; any other is recorded through
 * `run.end` first.
 */
export async function runAttempt(
  state: AttemptState,
  ports: AttemptPorts,
  limit: number,
  system: string | undefined,
  task: string,
): Promise<AttemptEnd> {
  // Refused before the fresh store is entered: inside it, a planted hook is
  // already out of sight.
  const refused = runRefused(process.env);
  return await isolated(async () => {
    let stop: RunEnd;
    try {
      if (refused) throw new RunEnd('TRACING_NOT_ALLOWED', false);
      const agent = createOpsAstroAgent(state, ports, limit);
      const messages = [
        ...(system === undefined ? [] : [new SystemMessage(system)]),
        new HumanMessage(task),
      ];
      const done = await agent.invoke(
        { messages },
        { configurable: { thread_id: `attempt:${state.taskId}` } },
      );
      const last = done.messages.at(-1);
      if (
        state.ended === undefined &&
        AIMessage.isInstance(last) &&
        last.tool_calls?.length === 0
      ) {
        return { outcome: 'success', endCode: 'COMPLETED' };
      }
      stop = state.ended ?? new RunEnd('TURN_MALFORMED', false);
    } catch (error) {
      stop = stopOf(state, error);
    }
    if (!stop.recorded) await ports.end(stop.endCode);
    return { outcome: stop.outcome ?? outcomeOf(stop.endCode), endCode: stop.endCode };
  });
}
