// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's turn on the owner's ChatGPT plan (#2091). The broker binds a
// turn's parts to what it owns and hands this adapter two fields: `turn`,
// the bound messages in order, and `tools`, the catalogue names the turn
// offered. The adapter writes them as the plan's pinned Responses call
// through `chatgptPlanBody`, so the model agent's check on the M5 admits
// exactly these bytes:
//
// - the task, and each later user part, a `{ role: 'user' }` turn;
// - an answer's words a `{ role: 'assistant' }` turn, and each of its calls
//   a `function_call` under its id, its arguments in canonical JSON;
// - a tool result a `function_call_output` under the call it answers;
// - a system part, once #1904 binds definitions, the instructions; until
//   then the pinned ones stand.
//
// Text only (register 164): the plan is offered no tool, so it can only
// answer in words, and an answer holding any call is malformed.

import { canonicalPayload } from '../../core-digest/src/index.ts';
import {
  CHATGPT_PLAN_ANSWER_BYTES,
  CHATGPT_PLAN_DEFAULT_MODEL,
  CHATGPT_PLAN_PATH,
  CHATGPT_PLAN_PROVIDER,
  CHATGPT_PLAN_TIMEOUT_MS,
  chatgptPlanBody,
  readChatgptPlanAnswer,
  readChatgptPlanToolCalls,
  type PlanItem,
} from './chatgpt-plan.ts';
import type { AdapterRequest, ModelAnswer, ModelOperationDeclaration } from './operation.ts';

/** The one key the agent's runner names for a turn, whichever provider an install answers it with. */
export const AGENT_TURN_KEY = 'model.agent_turn';

/** The instructions a turn goes under while no definition part is bound (#1904). */
export const AGENT_TURN_INSTRUCTIONS: string = [
  'You are working one task for this business in Ops Astro.',
  'The task is given as JSON. Work only on what it asks.',
  'Use only the tools you are offered, and answer in Australian English.',
].join('\n');

type Message =
  | { readonly role: 'system' | 'user'; readonly text: string }
  | {
      readonly role: 'assistant';
      readonly text: string;
      readonly toolCalls: readonly {
        readonly id: string;
        readonly name: string;
        readonly args: Readonly<Record<string, unknown>>;
      }[];
    }
  | { readonly role: 'tool'; readonly toolCallId: string; readonly text: string };

/** The bound messages; the broker writes them, so anything else is no turn and sends no input. */
function messagesOf(text: string | undefined): readonly Message[] {
  try {
    const parsed: unknown = JSON.parse(text ?? '');
    return Array.isArray(parsed) ? (parsed as Message[]) : [];
  } catch {
    return [];
  }
}

/** One bound message as the plan's input items; an answer's empty words send no assistant turn. */
function itemsOf(message: Message): readonly PlanItem[] {
  switch (message.role) {
    case 'user':
      return [{ role: 'user', content: message.text }];
    case 'assistant':
      return [
        ...(message.text === '' ? [] : [{ role: 'assistant' as const, content: message.text }]),
        ...message.toolCalls.map((call) => ({
          type: 'function_call' as const,
          call_id: call.id,
          name: call.name,
          arguments: canonicalPayload(call.args),
        })),
      ];
    case 'tool':
      return [{ type: 'function_call_output', call_id: message.toolCallId, output: message.text }];
    default:
      return [];
  }
}

/**
 * The adapter: the turn's messages as the pinned call on the plan's smaller
 * model, under a bound system part's words or the pinned instructions. A
 * malformed `turn` sends no input, which the M5's check refuses.
 */
export function chatgptPlanTurnAdapter(
  values: Readonly<Record<string, string>>,
  _operationId?: string,
): AdapterRequest {
  const messages = messagesOf(values['turn']);
  const system = messages.find((message) => message.role === 'system');
  return {
    path: CHATGPT_PLAN_PATH,
    method: 'POST',
    body: chatgptPlanBody({
      model: CHATGPT_PLAN_DEFAULT_MODEL,
      instructions: system?.text ?? AGENT_TURN_INSTRUCTIONS,
      input: messages.flatMap((message) => itemsOf(message)),
    }),
  };
}

/**
 * A turn's answer: the plan's words, with no calls (none is an absent
 * `toolCalls`), since text only offers it no tool; any call is malformed.
 */
export function readChatgptPlanTurnAnswer(body: unknown): ModelAnswer | undefined {
  const calls = readChatgptPlanToolCalls(body);
  return calls?.length === 0 ? readChatgptPlanAnswer(body) : undefined;
}

/**
 * The agent's turn on the owner's plan, under the plan's provider key so its
 * route stays the plan's and the owner-started rule names it. Unpriced, since
 * the plan is paid for, and once written every ending short of a completed
 * answer is held (#1929).
 */
export const CHATGPT_PLAN_TURN: ModelOperationDeclaration = {
  key: AGENT_TURN_KEY,
  provider: CHATGPT_PLAN_PROVIDER,
  destination: CHATGPT_PLAN_PROVIDER,
  fields: { turn: 'business_internal', tools: 'business_internal' },
  answer: readChatgptPlanTurnAnswer,
  timeoutMs: CHATGPT_PLAN_TIMEOUT_MS,
  maxResponseBytes: CHATGPT_PLAN_ANSWER_BYTES,
  maximumMinor: 0,
  settlesAt: 'completed',
  nothingHappened: [],
  billed: false,
  concurrency: 1,
};
