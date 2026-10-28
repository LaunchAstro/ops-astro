// SPDX-License-Identifier: AGPL-3.0-only
//
// The two requests the model agent sends. Ollama's: a streamed chat, thinking
// off, with an offered model, to `/api/chat` by POST, within the wait and
// answer size the catalogue gives an Ollama chat. OpenRouter's paid chat,
// exactly as the broker pins it (`openrouterRequest`), every value checked
// nested, within its declaration's wait and answer size, so nothing can widen
// what a reply may cost. The owner's ChatGPT plan's Responses call, exactly
// as `chatgptPlanBody` writes it (#1620 P4): one of the plan's two models, the
// instructions, `{ role, content }` turns, unstored and streamed, and nothing
// else but offered tools, each a strict function tool within its depth and
// size, with the model's earlier calls and their outputs. Hermes Agent's chat,
// exactly as `hermesRequest` writes it (#2270): its one model, the
// conversation's own `{ role, content }` turns ending with the person's,
// streamed, and nothing else. Anything else is refused before custody sees it.

import { isDeepStrictEqual } from 'node:util';
import {
  CHATGPT_PLAN_ANSWER_BYTES,
  CHATGPT_PLAN_BODY_LIMIT,
  CHATGPT_PLAN_MODELS,
  CHATGPT_PLAN_PARAMETERS_BYTES,
  CHATGPT_PLAN_PARAMETERS_DEPTH,
  CHATGPT_PLAN_PATH,
  CHATGPT_PLAN_PROVIDER,
  CHATGPT_PLAN_TIMEOUT_MS,
  chatgptPlanBody,
  HERMES_BODY_LIMIT,
  HERMES_CONVERSATION,
  HERMES_MODEL,
  HERMES_PATH,
  OLLAMA_MODELS,
  OLLAMA_PATH,
  OPENROUTER_CONVERSATION,
  OPENROUTER_BODY_LIMIT,
  OPENROUTER_MAX_TOKENS,
  OPENROUTER_PATH,
  openrouterModel,
  type PlanItem,
  type PlanTool,
} from '../../packages/core-connectors/src/index.ts';
import type { OutboundRequest } from '../../packages/core-custody/src/agent.ts';

/** Each destination's one path, and the longest wait and largest answer the catalogue gives it. */
const BOUNDS: ReadonlyMap<string, { path: string; ms: number; bytes: number }> = new Map([
  ['ollama', { path: OLLAMA_PATH, ms: 120_000, bytes: 256 * 1024 }],
  [
    OPENROUTER_CONVERSATION.destination,
    {
      path: OPENROUTER_PATH,
      ms: OPENROUTER_CONVERSATION.timeoutMs,
      bytes: OPENROUTER_CONVERSATION.maxResponseBytes,
    },
  ],
  [
    CHATGPT_PLAN_PROVIDER,
    { path: CHATGPT_PLAN_PATH, ms: CHATGPT_PLAN_TIMEOUT_MS, bytes: CHATGPT_PLAN_ANSWER_BYTES },
  ],
  [
    HERMES_CONVERSATION.destination,
    {
      path: HERMES_PATH,
      ms: HERMES_CONVERSATION.timeoutMs,
      bytes: HERMES_CONVERSATION.maxResponseBytes,
    },
  ],
]);

const ROLES: ReadonlySet<unknown> = new Set(['system', 'user', 'assistant']);

export const same = (keys: string, wanted: string): boolean =>
  keys === wanted.split(',').toSorted().join();

export const keysOf = (value: object): string => Object.keys(value).toSorted().join();

/** Turns as `openrouterRequest` writes them: the instructions once and first, the person's message last. */
const pinnedOrder = (turns: readonly Record<string, unknown>[]): boolean =>
  turns.length >= 2 &&
  turns.every((turn, at) => (turn['role'] === 'system') === (at === 0)) &&
  turns.at(-1)?.['role'] === 'user';

/**
 * OpenRouter's pinned chat: an offered model at its own prices, the instructions
 * first and only first, the person's message last. The body sent is the one checked: exactly its own serialisation, so no
 * key named twice or other spelling can carry a value unread here, and within
 * the bytes every hold is worked from.
 */
function paidChat(chat: Record<string, unknown>, body: string): boolean {
  if (JSON.stringify(chat) !== body || Buffer.byteLength(body) > OPENROUTER_BODY_LIMIT) {
    return false;
  }
  const model = openrouterModel(String(chat['model']));
  const turns = chat['messages'];
  const valid =
    Array.isArray(turns) &&
    turns.every(
      (turn: Record<string, unknown> | null) =>
        typeof turn?.['content'] === 'string' &&
        ROLES.has(turn['role']) &&
        same(keysOf(turn), 'content,role'),
    ) &&
    pinnedOrder(turns as Record<string, unknown>[]);
  return (
    valid &&
    model !== undefined &&
    isDeepStrictEqual(chat, {
      model: model.id,
      messages: turns,
      stream: true,
      max_tokens: OPENROUTER_MAX_TOKENS,
      usage: { include: true },
      provider: {
        max_price: { prompt: model.promptPerMillion, completion: model.completionPerMillion },
        data_collection: 'deny',
        allow_fallbacks: false,
      },
    })
  );
}

const PLAN_ROLES: ReadonlySet<unknown> = new Set(['user', 'assistant']);
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/u;

/** Whether a value nests deeper than `most` objects, judged from its own list, not the call stack. */
function deeper(value: unknown, most: number): boolean {
  const pending: [unknown, number][] = [[value, 1]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [item, depth] = next;
    if (typeof item !== 'object' || item === null) continue;
    if (depth > most) return true;
    for (const child of Object.values(item)) pending.push([child, depth + 1]);
  }
  return false;
}

/** One offered tool: a strict function tool, its parameters an object within their depth and size. */
function planTool(tool: Record<string, unknown> | null): boolean {
  const parameters = tool?.['parameters'];
  return (
    typeof tool === 'object' &&
    tool !== null &&
    same(keysOf(tool), 'description,name,parameters,strict,type') &&
    tool['type'] === 'function' &&
    tool['strict'] === true &&
    TOOL_NAME.test(String(tool['name'])) &&
    typeof tool['description'] === 'string' &&
    typeof parameters === 'object' &&
    parameters !== null &&
    !Array.isArray(parameters) &&
    Buffer.byteLength(JSON.stringify(parameters)) <= CHATGPT_PLAN_PARAMETERS_BYTES &&
    !deeper(parameters, CHATGPT_PLAN_PARAMETERS_DEPTH)
  );
}

/** Tools absent, or a list of distinct, well-shaped ones. */
const planTools = (tools: unknown): boolean =>
  tools === undefined ||
  (Array.isArray(tools) &&
    tools.length > 0 &&
    tools.every((tool: Record<string, unknown> | null) => planTool(tool)) &&
    new Set(tools.map((tool: Record<string, unknown>) => tool['name'])).size === tools.length);

/** Turns, and with tools offered, the model's earlier calls, each output after its call. */
function planItems(input: unknown, offered: boolean): boolean {
  if (!Array.isArray(input) || input.length === 0) return false;
  const calls = new Set<unknown>();
  return input.every((item: Record<string, unknown> | null) => {
    if (typeof item !== 'object' || item === null) return false;
    const keys = keysOf(item);
    const texts = (names: string): boolean =>
      same(keys, names) &&
      names.split(',').every((name) => name === 'type' || typeof item[name] === 'string');
    if (same(keys, 'content,role')) return texts('content,role') && PLAN_ROLES.has(item['role']);
    if (!offered) return false;
    if (item['type'] === 'function_call' && texts('arguments,call_id,name,type')) {
      calls.add(item['call_id']);
      return true;
    }
    return (
      item['type'] === 'function_call_output' &&
      texts('call_id,output,type') &&
      calls.has(item['call_id'])
    );
  });
}

/**
 * The plan's pinned Responses call: the body sent is exactly `chatgptPlanBody`
 * of what it holds, so no field, key order, spelling or repeated key the route
 * does not take can pass, within the route's body limit.
 */
function planCall(call: Record<string, unknown>, body: string): boolean {
  const { model, instructions, input, tools } = call;
  const offered = tools !== undefined;
  return (
    planTools(tools) &&
    planItems(input, offered) &&
    typeof model === 'string' &&
    CHATGPT_PLAN_MODELS.includes(model) &&
    typeof instructions === 'string' &&
    Buffer.byteLength(body) <= CHATGPT_PLAN_BODY_LIMIT &&
    chatgptPlanBody({
      model,
      instructions,
      input: input as PlanItem[],
      ...(offered ? { tools: tools as PlanTool[] } : {}),
    }) === body
  );
}

/**
 * Hermes Agent's chat as `hermesRequest` writes it: the body sent is exactly
 * the serialisation of its one model, its `{ role, content }` turns (the
 * person's and the answers', the person's last) and `stream: true`, so no
 * instructions, tools, provider or repeated key can pass, within its body limit.
 */
function hermesChat(chat: Record<string, unknown>, body: string): boolean {
  const turns = chat['messages'];
  if (!Array.isArray(turns) || turns.length === 0 || Buffer.byteLength(body) > HERMES_BODY_LIMIT) {
    return false;
  }
  const valid = turns.every(
    (turn: Record<string, unknown> | null) =>
      typeof turn?.['content'] === 'string' &&
      PLAN_ROLES.has(turn['role']) &&
      same(keysOf(turn), 'content,role'),
  );
  const messages = valid
    ? (turns as Record<string, unknown>[]).map(({ role, content }) => ({ role, content }))
    : [];
  return (
    valid &&
    messages.at(-1)?.role === 'user' &&
    JSON.stringify({ model: HERMES_MODEL, messages, stream: true }) === body
  );
}

/** One of the agent's requests, within the catalogue's bounds. */
export function chatOf(request: unknown): OutboundRequest | undefined {
  if (typeof request !== 'object' || request === null) return undefined;
  const asked = request as OutboundRequest;
  const bounds = BOUNDS.get(asked.destination);
  if (
    bounds === undefined ||
    !same(keysOf(asked), 'body,destination,maxResponseBytes,method,path,timeoutMs') ||
    asked.method !== 'POST' ||
    asked.path !== bounds.path ||
    !Number.isSafeInteger(asked.timeoutMs) ||
    asked.timeoutMs < 1 ||
    asked.timeoutMs > bounds.ms ||
    !Number.isSafeInteger(asked.maxResponseBytes) ||
    asked.maxResponseBytes < 1 ||
    asked.maxResponseBytes > bounds.bytes ||
    typeof asked.body !== 'string'
  ) {
    return undefined;
  }
  let chat: unknown;
  try {
    chat = JSON.parse(asked.body);
  } catch {
    return undefined;
  }
  if (typeof chat !== 'object' || chat === null || Array.isArray(chat)) return undefined;
  if (asked.destination === CHATGPT_PLAN_PROVIDER)
    return planCall(chat as Record<string, unknown>, asked.body) ? asked : undefined;
  if (asked.destination === HERMES_CONVERSATION.destination)
    return hermesChat(chat as Record<string, unknown>, asked.body) ? asked : undefined;
  if (asked.destination !== 'ollama')
    return paidChat(chat as Record<string, unknown>, asked.body) ? asked : undefined;
  const { model, messages, stream, think } = chat as Record<string, unknown>;
  const offered = (OLLAMA_MODELS as readonly unknown[]).includes(model);
  const ok =
    same(keysOf(chat), 'messages,model,stream,think') && stream === true && think === false;
  return ok && offered && Array.isArray(messages) ? asked : undefined;
}
