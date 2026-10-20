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
// The tools the turn offered go to the plan as strict function tools, under
// the plan's name for each from one closed table (#2115): `task.read` is
// `task_read` and `live_correction.request` is `live_correction_request`. A
// name outside it, offered or in a call, sends no input. The answer's calls
// come back under the catalogue's names, each held to its tool's operands
// exactly as the broker holds them (`broker-turn-read.ts`); one out of shape
// makes the whole answer malformed.

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
  type PlanTool,
  type PlanToolCall,
} from './chatgpt-plan.ts';
import type {
  AdapterRequest,
  ModelAnswer,
  ModelOperationDeclaration,
  ModelToolCall,
} from './operation.ts';
import { AGENT_TURN_KEY } from './replay-adapter.ts';

/** The instructions a turn goes under while no definition part is bound (#1904). */
export const AGENT_TURN_INSTRUCTIONS: string = [
  'You are working one task for this business in Ops Astro.',
  'The task is given as JSON. Work only on what it asks.',
  'Use only the tools you are offered, and answer in Australian English.',
].join('\n');

interface AgentTool {
  /** The plan's name for it: the Responses route takes no dot in a tool's name. */
  readonly plan: string;
  readonly description: string;
  readonly operands: readonly string[];
}

/**
 * The closed name table: each catalogue tool the plan may be offered, by the
 * catalogue's name, with its operands, every one a string. They are the
 * catalogue's (`declarationOf`), which connectors may not import; a pin test
 * holds them equal.
 */
const TOOLS: ReadonlyMap<string, AgentTool> = new Map([
  [
    'task.read',
    { plan: 'task_read', description: 'Read this task as it stands now.', operands: ['taskId'] },
  ],
  [
    'live_correction.request',
    {
      plan: 'live_correction_request',
      description:
        "Ask for one word on the business's own live page to be replaced by another. A person reviews it.",
      operands: ['taskId', 'page', 'word', 'replacement'],
    },
  ],
]);

/** A tool as the plan is offered it: strict, every operand a required string and nothing else. */
const planToolOf = ({ plan, description, operands }: AgentTool): PlanTool => ({
  name: plan,
  description,
  parameters: {
    type: 'object',
    properties: Object.fromEntries(operands.map((key) => [key, { type: 'string' }])),
    required: operands,
    additionalProperties: false,
  },
});

/** The catalogue's name for each of the plan's. */
const CATALOGUE: ReadonlyMap<string, string> = new Map(
  [...TOOLS].map(([name, { plan }]) => [plan, name]),
);

/** The broker's bounds on a call's arguments (`broker-turn-read.ts`) and the plan's on its ids. */
const MOST_OPERAND_UNITS = 4096;
const MOST_ARGUMENT_BYTES = 16 * 1024;
const CALL_ID = /^[A-Za-z0-9_-]{1,128}$/u;

type Message =
  | { readonly role: 'system' | 'user'; readonly text: string }
  | {
      readonly role: 'assistant';
      readonly text: string;
      readonly toolCalls: readonly ModelToolCall[];
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

/** The offered tools as the plan takes them, or undefined when one is outside the table. */
function toolsOf(text: string | undefined): readonly PlanTool[] | undefined {
  try {
    const names: unknown = JSON.parse(text ?? '[]');
    if (!Array.isArray(names)) return undefined;
    const tools = names.map((name) => TOOLS.get(String(name)));
    return tools.every((tool) => tool !== undefined)
      ? tools.map((tool) => planToolOf(tool))
      : undefined;
  } catch {
    return undefined;
  }
}

/** One bound message as the plan's input items; an answer's empty words send no assistant turn. */
function itemsOf(message: Message): readonly (PlanItem | undefined)[] {
  switch (message.role) {
    case 'user':
      return [{ role: 'user', content: message.text }];
    case 'assistant':
      return [
        ...(message.text === '' ? [] : [{ role: 'assistant' as const, content: message.text }]),
        ...message.toolCalls.map((call) => {
          const plan = TOOLS.get(call.name)?.plan;
          return plan === undefined
            ? undefined
            : {
                type: 'function_call' as const,
                call_id: call.id,
                name: plan,
                arguments: canonicalPayload(call.args),
              };
        }),
      ];
    case 'tool':
      return [{ type: 'function_call_output', call_id: message.toolCallId, output: message.text }];
    default:
      return [];
  }
}

/**
 * The adapter: the turn's messages as the pinned call on the plan's smaller
 * model, under a bound system part's words or the pinned instructions, with
 * the tools the turn offered. A malformed `turn`, or a tool outside the
 * table, sends no input, which the M5's check refuses.
 */
export function chatgptPlanTurnAdapter(
  values: Readonly<Record<string, string>>,
  _operationId?: string,
): AdapterRequest {
  const messages = messagesOf(values['turn']);
  const system = messages.find((message) => message.role === 'system');
  const tools = toolsOf(values['tools']);
  const items = messages.flatMap((message) => itemsOf(message));
  const input = tools !== undefined && items.every((item) => item !== undefined) ? items : [];
  return {
    path: CHATGPT_PLAN_PATH,
    method: 'POST',
    body: chatgptPlanBody({
      model: CHATGPT_PLAN_DEFAULT_MODEL,
      instructions: system?.text ?? AGENT_TURN_INSTRUCTIONS,
      input: input as PlanItem[],
      ...(tools === undefined || tools.length === 0 ? {} : { tools }),
    }),
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Its arguments, a JSON object of exactly the tool's operands, or undefined. */
function argumentsOf(
  text: string,
  operands: readonly string[],
): Record<string, unknown> | undefined {
  let args: unknown;
  try {
    args = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(args) || Object.keys(args).length !== operands.length) return undefined;
  const kept = operands.every((key) => {
    const value = Object.hasOwn(args, key) ? args[key] : undefined;
    return typeof value === 'string' && value !== '' && value.length <= MOST_OPERAND_UNITS;
  });
  return kept && fits(args) ? args : undefined;
}

/** Whether arguments are within the bytes a turn carries; ones no canonical payload holds are not. */
function fits(args: Record<string, unknown>): boolean {
  try {
    return Buffer.byteLength(canonicalPayload(args), 'utf8') <= MOST_ARGUMENT_BYTES;
  } catch {
    return false;
  }
}

/** One of the plan's calls as the catalogue's, or undefined when it is out of shape. */
function callOf(call: PlanToolCall): ModelToolCall | undefined {
  const name = CATALOGUE.get(call.name);
  const tool = name === undefined ? undefined : TOOLS.get(name);
  if (name === undefined || tool === undefined || !CALL_ID.test(call.callId)) return undefined;
  const args = argumentsOf(call.arguments, tool.operands);
  return args === undefined ? undefined : { id: call.callId, name, args };
}

/**
 * A turn's answer: the plan's words, and its calls under the catalogue's
 * names (none is an absent `toolCalls`). Any call out of shape, or two under
 * one id, makes the whole answer malformed.
 */
export function readChatgptPlanTurnAnswer(body: unknown): ModelAnswer | undefined {
  const answer = readChatgptPlanAnswer(body);
  const calls = readChatgptPlanToolCalls(body);
  if (answer === undefined || calls === undefined) return undefined;
  if (calls.length === 0) return answer;
  const toolCalls = calls.map((call) => callOf(call));
  const once = new Set(calls.map((call) => call.callId)).size === calls.length;
  return once && toolCalls.every((call) => call !== undefined)
    ? { ...answer, toolCalls }
    : undefined;
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
  turn: true,
  answer: readChatgptPlanTurnAnswer,
  timeoutMs: CHATGPT_PLAN_TIMEOUT_MS,
  maxResponseBytes: CHATGPT_PLAN_ANSWER_BYTES,
  maximumMinor: 0,
  settlesAt: 'completed',
  nothingHappened: [],
  billed: false,
  concurrency: 1,
};
