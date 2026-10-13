// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's ChatGPT plan route (#1620): the public Responses endpoint,
// answered from the owner's machine, where custody holds the plan's sign-in
// and presents its access token (`plan-token.ts`). Only runs the owner
// started reach it (`planCarry`).
//
// The request is pinned: a model the plan offers, the instructions, the
// turns, function tools in the shape the owner's one real call settles, and
// `store: false` with `stream: true`. Nothing else is sent: no temperature,
// top_p, output cap or earlier response, which the plan does not take.
// Custody reads the stream whole, folds it to the completed response and
// redacts that (`responses-fold.ts`): a presented token is never passed on
// chunk by chunk, and only the completed response crosses back.
//
// A 429 is the plan's allowance used up, `PLAN_ALLOWANCE_WAIT`, and a 403 a
// refusal, `SUBSCRIPTION_REFUSED`: each is proof nothing was done, the call
// is released, and neither is tried again. The plan is paid for already, so
// an answer costs nothing.

import {
  readModelId,
  type AdapterRequest,
  type ModelAnswer,
  type ModelOperationDeclaration,
} from './operation.ts';

/** The provider's key in routes and operations. */
export const CHATGPT_PLAN_PROVIDER = 'chatgpt_plan';

/** Custody's destination for the plan, and its one path. */
export const CHATGPT_PLAN_DESTINATION = 'chatgpt_plan';
export const CHATGPT_PLAN_PATH = '/v1/responses';

/** The models the plan is asked for: GPT Luna for checkable cases, GPT Sol for harder ones. */
export const CHATGPT_PLAN_MODELS: readonly string[] = ['gpt-6.1-luna', 'gpt-6.1-sol'];

/** Every field a plan request may hold; `tools` only when there are some. */
export const CHATGPT_PLAN_ASKED_FIELDS: readonly string[] = [
  'model',
  'instructions',
  'input',
  'tools',
  'store',
  'stream',
];

/** The most bytes one plan request body may hold. */
export const CHATGPT_PLAN_BODY_LIMIT: number = 256 * 1024;

/**
 * How a function tool is named to the plan. `top_level` until the owner's one
 * real call shows the plan wants names under a namespace
 * (`docs/local/chatgpt-plan.md`).
 */
export type ToolShape = 'top_level' | 'namespaced';
export const CHATGPT_PLAN_TOOL_SHAPE: ToolShape = 'top_level';

/** The namespace a `namespaced` tool's name is written under. */
const NAMESPACE = 'ops_astro__';

export interface PlanTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface PlanTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface PlanAsk {
  readonly model: string;
  readonly instructions: string;
  readonly input: readonly PlanTurn[];
  readonly tools?: readonly PlanTool[];
}

/** The pinned Responses request, its fields in one order. */
export function chatgptPlanRequest(
  ask: PlanAsk,
  shape: ToolShape = CHATGPT_PLAN_TOOL_SHAPE,
): AdapterRequest {
  const tools =
    ask.tools === undefined || ask.tools.length === 0
      ? undefined
      : ask.tools.map((tool) => ({
          type: 'function',
          strict: false,
          name: shape === 'namespaced' ? `${NAMESPACE}${tool.name}` : tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }));
  const body = {
    model: ask.model,
    instructions: ask.instructions,
    input: ask.input.map((turn) => ({ role: turn.role, content: turn.content })),
    ...(tools === undefined ? {} : { tools }),
    store: false,
    stream: true,
  };
  return { path: CHATGPT_PLAN_PATH, method: 'POST', body: JSON.stringify(body) };
}

/** The adapter: the task's instruction as the one turn, on the model asked for. */
export function chatgptPlanAdapter(
  values: Readonly<Record<string, string>>,
  _operationId?: string,
  model: string = CHATGPT_PLAN_MODELS[0] ?? '',
): AdapterRequest {
  return chatgptPlanRequest({
    model,
    instructions: 'Answer the task as asked.',
    input: [{ role: 'user', content: values['instruction'] ?? '' }],
  });
}

/** The plan's named answer to a refused status, or undefined for any other. */
export function chatgptPlanRefusal(
  status: number,
): 'PLAN_ALLOWANCE_WAIT' | 'SUBSCRIPTION_REFUSED' | undefined {
  if (status === 429) return 'PLAN_ALLOWANCE_WAIT';
  if (status === 403) return 'SUBSCRIPTION_REFUSED';
  return undefined;
}

const whole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const itemsOf = (body: unknown): readonly Record<string, unknown>[] => {
  const output = (body as { output?: unknown } | null)?.output;
  return Array.isArray(output)
    ? output.filter(
        (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
      )
    : [];
};

/** The completed response's text, model and usage, or nothing. */
export function readChatgptPlanAnswer(body: unknown): ModelAnswer | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const shape = body as Record<string, unknown>;
  if (shape['status'] !== 'completed') return undefined;
  const usage = shape['usage'] as Record<string, unknown> | null | undefined;
  if (typeof usage !== 'object' || usage === null) return undefined;
  if (!whole(usage['input_tokens']) || !whole(usage['output_tokens'])) return undefined;
  const model = readModelId(shape['model']);
  if (model === undefined) return undefined;
  const text = itemsOf(body)
    .filter((item) => item['type'] === 'message' && Array.isArray(item['content']))
    .flatMap((item) => item['content'] as unknown[])
    .map((part) => part as { type?: unknown; text?: unknown } | null)
    .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part) => String(part?.text))
    .join('');
  return {
    text,
    model,
    usage: { inputUnits: usage['input_tokens'], outputUnits: usage['output_tokens'] },
    providerCode: null,
  };
}

export interface PlanToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
}

/** The completed response's function calls, each name as the tool was named before any namespace. */
export function readChatgptPlanToolCalls(body: unknown): readonly PlanToolCall[] {
  return itemsOf(body)
    .filter(
      (item) =>
        item['type'] === 'function_call' &&
        typeof item['call_id'] === 'string' &&
        typeof item['name'] === 'string' &&
        typeof item['arguments'] === 'string',
    )
    .map((item) => {
      const name = String(item['name']);
      return {
        callId: String(item['call_id']),
        name: name.startsWith(NAMESPACE) ? name.slice(NAMESPACE.length) : name,
        arguments: String(item['arguments']),
      };
    });
}

/** The price of a plan answer: nothing, whatever the call used. */
export function chatgptPlanCostMinor(_answer: ModelAnswer): number {
  return 0;
}

/** The refusals that prove nothing was done: the plan's own, and custody's before any send. */
export const CHATGPT_PLAN_NOTHING_HAPPENED: readonly string[] = [
  'PLAN_ALLOWANCE_WAIT',
  'SUBSCRIPTION_REFUSED',
  'SUBSCRIPTION_SIGN_IN_NEEDED',
  'SUBSCRIPTION_REFRESH_FAILED',
  'SUBSCRIPTION_TOKEN_FILE_OPEN',
  'MODEL_MACHINE_BUSY',
  'SEND_LAPSED',
  'http_400',
  'http_401',
  'http_404',
  'http_413',
];

/** One turn on the owner's plan, for a run the owner started. */
export const CHATGPT_PLAN_TURN: ModelOperationDeclaration = {
  key: 'model.chatgpt_plan_turn',
  provider: CHATGPT_PLAN_PROVIDER,
  destination: CHATGPT_PLAN_DESTINATION,
  fields: { instruction: 'business_internal' },
  answer: readChatgptPlanAnswer,
  timeoutMs: 120_000,
  maxResponseBytes: 1024 * 1024,
  maximumMinor: 0,
  settlesAt: 'completed',
  nothingHappened: CHATGPT_PLAN_NOTHING_HAPPENED,
  billed: true,
  concurrency: 2,
};
