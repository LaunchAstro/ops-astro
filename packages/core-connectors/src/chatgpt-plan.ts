// SPDX-License-Identifier: AGPL-3.0-only
//
// The `chatgpt-plan` route (#1620 P4): the owner's own ChatGPT plan, answered
// from the M5. Custody there holds the plan's token (`plan-token.ts`) and
// calls the public Responses endpoint at `https://api.openai.com` with it;
// nothing here holds or names a token.
//
// The request is pinned. Its body is exactly `model`, `instructions`,
// `input`, `tools` when the call offers any, `store: false` and `stream:
// true`, written in that order by `chatgptPlanBody`, so the bytes captured
// are the bytes checked: no temperature, no token cap, no stored
// conversation, nothing the plan's Responses route does not take. The model
// is one of the plan's two. Each input turn is `{ role, content }`, the role
// `user` or `assistant`; the instructions travel once, in `instructions`. A
// call that offers tools may also carry the model's earlier `function_call`
// items and their `function_call_output`. Each tool is a strict function
// tool, and its `parameters` are the one free JSON in the body. The answer is
// custody's folded completed response, read for its words and, apart, for the
// model's calls.

import { conversationInstructions, promptPage } from './conversation-prompt.ts';
import { earlierTurns } from './ollama.ts';
import {
  readModelId,
  type AdapterRequest,
  type ModelAnswer,
  type ModelOperationDeclaration,
} from './operation.ts';
import { CONVERSATION_ANSWER } from './replay.ts';

/** The route's provider key and the destination custody sends it to. */
export const CHATGPT_PLAN_PROVIDER = 'chatgpt_plan';

/** The public Responses endpoint's one path. */
export const CHATGPT_PLAN_PATH = '/v1/responses';

/** The only addresses the route's custody reaches: the Responses endpoint and the plan's issuer. */
export const CHATGPT_PLAN_ORIGIN = 'https://api.openai.com';
export const CHATGPT_PLAN_ISSUER = 'https://auth.openai.com';

/** The plan's two models: the smaller for basic checks, the larger for harder ones (spec #1612 story 20). */
export const CHATGPT_PLAN_DEFAULT_MODEL = 'gpt-6.1-luna';
export const CHATGPT_PLAN_MODELS: readonly string[] = [CHATGPT_PLAN_DEFAULT_MODEL, 'gpt-6.1-sol'];

/** The most bytes one request body may hold. */
export const CHATGPT_PLAN_BODY_LIMIT: number = 64 * 1024;

/** The longest a plan call may take, and the largest streamed answer custody reads. */
export const CHATGPT_PLAN_TIMEOUT_MS = 120_000;
export const CHATGPT_PLAN_ANSWER_BYTES: number = 1024 * 1024;

/**
 * Custody's plan answers that prove nothing was kept (#1625 R9), for the plan
 * operation's `nothingHappened` (#1971): the usage allowance (429 or a
 * mid-stream usage limit), the plan unavailable (503) and signing in again
 * (401). Each ends the run in its own code, never retried. Any other plan
 * answer proves nothing and is held unknown.
 */
export const CHATGPT_PLAN_NOTHING_HAPPENED: readonly string[] = [
  'SUBSCRIPTION_PLAN_ALLOWANCE',
  'SUBSCRIPTION_PLAN_UNAVAILABLE',
  'SUBSCRIPTION_SIGN_IN_NEEDED',
];

export interface PlanTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface PlanCall {
  readonly type: 'function_call';
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface PlanCallOutput {
  readonly type: 'function_call_output';
  readonly call_id: string;
  readonly output: string;
}

export type PlanItem = PlanTurn | PlanCall | PlanCallOutput;

export interface PlanTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface PlanAsk {
  readonly model: string;
  readonly instructions: string;
  readonly input: readonly PlanItem[];
  readonly tools?: readonly PlanTool[];
}

/** The deepest and largest a tool's `parameters` may be. */
export const CHATGPT_PLAN_PARAMETERS_DEPTH = 16;
export const CHATGPT_PLAN_PARAMETERS_BYTES: number = 16 * 1024;

/** A call the plan's model made, as the answer reader gives it back. */
export interface PlanToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
}

/** One input item rebuilt in its one key order: a turn, an earlier call, or that call's output. */
function itemOf(item: PlanItem): Record<string, unknown> {
  if ('type' in item && item.type === 'function_call') {
    return { type: item.type, call_id: item.call_id, name: item.name, arguments: item.arguments };
  }
  if ('type' in item) return { type: item.type, call_id: item.call_id, output: item.output };
  return { role: item.role, content: item.content };
}

/**
 * A tool as the Responses endpoint takes it: a strict function tool, keys in
 * their one order. Its name goes as given; whether names are namespaced waits
 * for the owner's one real call (#1705), and would change only this function.
 */
const toolOf = (tool: PlanTool): Record<string, unknown> => ({
  type: 'function',
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters,
  strict: true,
});

/** The pinned body, keys in their one order, each item and tool rebuilt in its own. */
export function chatgptPlanBody(ask: PlanAsk): string {
  return JSON.stringify({
    model: ask.model,
    instructions: ask.instructions,
    input: ask.input.map((item) => itemOf(item)),
    ...(ask.tools === undefined ? {} : { tools: ask.tools.map((tool) => toolOf(tool)) }),
    store: false,
    stream: true,
  });
}

/**
 * The adapter: a person's question in their conversation, as the pinned call
 * for the model asked for (the smaller unless named), with any tools offered.
 * A model outside the plan's two sends no input, which the M5's check refuses.
 */
export function chatgptPlanAdapter(
  values: Readonly<Record<string, string>>,
  _operationId?: string,
  model: string = CHATGPT_PLAN_DEFAULT_MODEL,
  tools?: readonly PlanTool[],
): AdapterRequest {
  const input: PlanTurn[] = CHATGPT_PLAN_MODELS.includes(model)
    ? [
        ...earlierTurns(values['earlier']).flatMap((turn) =>
          turn.role === 'system' ? [] : [{ role: turn.role, content: turn.content }],
        ),
        { role: 'user', content: values['message'] ?? '' },
      ]
    : [];
  const instructions = conversationInstructions(promptPage(values['page']));
  return {
    path: CHATGPT_PLAN_PATH,
    method: 'POST',
    body: chatgptPlanBody({ model, instructions, input, ...(tools ? { tools } : {}) }),
  };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

/** A completed response's output items, when it has a list of them. */
const outputOf = (body: unknown): readonly Record<string, unknown>[] | undefined =>
  record(body) && Array.isArray(body['output']) && body['output'].every((item) => record(item))
    ? (body['output'] as Record<string, unknown>[])
    : undefined;

/**
 * The calls the model made, in order, from custody's folded completed
 * response: none in an answer of words only, undefined when a call is out of
 * shape. Read apart from the answer, which keeps its shape until #1715.
 */
export function readChatgptPlanToolCalls(body: unknown): readonly PlanToolCall[] | undefined {
  const calls = outputOf(body)?.filter((item) => item['type'] === 'function_call');
  const read = calls?.map((item) => ({
    callId: item['call_id'],
    name: item['name'],
    arguments: item['arguments'],
  }));
  const shaped = read?.every((call) => Object.values(call).every((v) => typeof v === 'string'));
  return shaped === true ? (read as PlanToolCall[]) : undefined;
}

/**
 * The answer schema, custody's folded completed response: the output text
 * joined, the usage counts and the model. Words or a call it must have.
 */
export function readChatgptPlanAnswer(body: unknown): ModelAnswer | undefined {
  const output = outputOf(body);
  const calls = readChatgptPlanToolCalls(body);
  if (!record(body) || output === undefined || calls === undefined) return undefined;
  const { usage } = body;
  const model = readModelId(body['model']);
  if (!record(usage) || !count(usage['input_tokens']) || !count(usage['output_tokens'])) return;
  const parts = output.flatMap((item) =>
    item['type'] === 'message' && Array.isArray(item['content']) ? item['content'] : [],
  );
  const text = parts
    .flatMap((part) => (record(part) && part['type'] === 'output_text' ? [part['text']] : []))
    .join('');
  if (model === undefined || (text === '' && calls.length === 0)) return undefined;
  const units = { inputUnits: usage['input_tokens'], outputUnits: usage['output_tokens'] };
  return { text, model, usage: units, providerCode: null };
}

/**
 * A person's question answered on the owner's ChatGPT plan. The plan is
 * already paid for, so every answer costs nothing and the operation is unpriced.
 */
export const CHATGPT_PLAN_CONVERSATION: ModelOperationDeclaration = {
  key: 'model.chatgpt_plan_answer',
  provider: CHATGPT_PLAN_PROVIDER,
  destination: CHATGPT_PLAN_PROVIDER,
  fields: CONVERSATION_ANSWER.fields,
  answer: readChatgptPlanAnswer,
  timeoutMs: CHATGPT_PLAN_TIMEOUT_MS,
  maxResponseBytes: CHATGPT_PLAN_ANSWER_BYTES,
  maximumMinor: 0,
  settlesAt: 'completed',
  // None: a plan answer reaches the broker only once its request is written, when the plan
  // may have run it, so custody holds every ending short of a completed response (#1926).
  nothingHappened: [],
  billed: false,
  concurrency: 1,
};
