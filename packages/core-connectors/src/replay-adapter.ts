// SPDX-License-Identifier: AGPL-3.0-only
//
// The replay model provider's adapter half (AW-01): what runs in the broker's process. It builds
// a request with no origin and no credential, reads the answer against its schema, and prices it.
// The server half, which answers on loopback, is `replay.ts`.

import {
  readModelId,
  type AdapterRequest,
  type ModelAnswer,
  type ModelOperationDeclaration,
  type ModelToolCall,
} from './operation.ts';

/** The model window the replay provider declares, recorded for the harness adoption test (AW-12). */
export const REPLAY_MODEL_WINDOW: { readonly model: string; readonly contextUnits: number } = {
  model: 'replay-1',
  contextUnits: 32_000,
};

/** The provider code that proves nothing happened: refused before any work began. */
export const REPLAY_NOTHING_HAPPENED = 'rejected_before_processing';

export const REPLAY_PATH = '/v1/complete';

/**
 * The adapter: fields in, a request with neither origin nor credential out.
 * The operation id is the call's own, so a lookup can later name it (AW-10).
 */
export function replayAdapter(
  values: Readonly<Record<string, string>>,
  operationId?: string,
  model: string = REPLAY_MODEL_WINDOW.model,
): AdapterRequest {
  return {
    path: REPLAY_PATH,
    method: 'POST',
    body: JSON.stringify({
      model,
      fields: values,
      ...(operationId === undefined ? {} : { operation_id: operationId }),
    }),
  };
}

const whole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The tools asked for, each `{ id, name, args }` and nothing else; absent, none; else undefined. */
function toolCallsOf(value: unknown): readonly ModelToolCall[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const calls: ModelToolCall[] = [];
  for (const call of value) {
    if (!isObject(call) || Object.keys(call).length !== 3) return undefined;
    const { id, name, args } = call;
    if (typeof id !== 'string' || typeof name !== 'string' || !isObject(args)) return undefined;
    calls.push({ id, name, args });
  }
  return calls;
}

/** The answer schema: exactly the shape below, or nothing. */
export function readReplayAnswer(body: unknown): ModelAnswer | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const shape = body as Record<string, unknown>;
  const usage = shape['usage'];
  if (typeof shape['text'] !== 'string') return undefined;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const units = usage as Record<string, unknown>;
  if (!whole(units['input']) || !whole(units['output'])) return undefined;
  const code = shape['code'];
  if (code !== undefined && code !== null && typeof code !== 'string') return undefined;
  const model = readModelId(shape['model']);
  if (model === undefined) return undefined;
  const toolCalls = toolCallsOf(shape['tool_calls']);
  if (toolCalls === undefined) return undefined;
  return {
    text: shape['text'],
    ...(shape['tool_calls'] === undefined ? {} : { toolCalls }),
    model,
    usage: { inputUnits: units['input'], outputUnits: units['output'] },
    providerCode: typeof code === 'string' ? code : null,
  };
}

/** One catalogued operation over the replay provider, used by the broker's cases and the stand-in stack. */
export const REPLAY_COMPOSE: ModelOperationDeclaration = {
  key: 'model.replay_compose',
  provider: 'replay',
  destination: 'replay',
  fields: { instruction: 'free_text', tone: 'business_internal' },
  answer: readReplayAnswer,
  timeoutMs: 2_000,
  maxResponseBytes: 64 * 1024,
  maximumMinor: 500,
  settlesAt: 'completed',
  // A 429 is the provider's own word that it began nothing (AW-10).
  nothingHappened: [REPLAY_NOTHING_HAPPENED, 'http_429'],
  billed: true,
  concurrency: 4,
};

/**
 * A person's question in their own conversation (AW-03's exchange), over the replay provider until
 * a real local provider lands (AW-RP). The question is a person's own words, so it is free text: it
 * reaches only a local route, and the conversation seam takes no other.
 */
export const CONVERSATION_ANSWER: ModelOperationDeclaration = {
  ...REPLAY_COMPOSE,
  key: 'model.conversation_answer',
  // `message` is the person's own typed words; `earlier` this conversation's earlier messages,
  // the person's words and the agent's replies; `page` the id and title of the task the
  // conversation is on, and nothing else of it. Each is any string a person typed, so free
  // text: local routes only, or LA-1's laptop carve-out. The stand-in prices every answer
  // (`replayCostMinor`), so it keeps the compose's priced maximum, and the seam refuses it (#1508).
  fields: { page: 'free_text', earlier: 'free_text', message: 'free_text' },
};

/**
 * A model turn over the replay provider (#1623 R3): the broker materialises the
 * turn's parts into its one field, and finds its class from their sources.
 */
export const REPLAY_TURN: ModelOperationDeclaration = {
  ...REPLAY_COMPOSE,
  key: 'model.replay_turn',
  fields: { turn: 'business_internal' },
  turn: true,
};

/** The one key the agent's runner names for a turn, whichever provider an install answers it with (#2091). */
export const AGENT_TURN_KEY = 'model.agent_turn';

/** The agent's turn where an install answers it with the replay provider. */
export const REPLAY_AGENT_TURN: ModelOperationDeclaration = { ...REPLAY_TURN, key: AGENT_TURN_KEY };

/** The price of an answer, in minor units, from what the provider says it used. Never above the maximum. */
export function replayCostMinor(read: ModelAnswer): number {
  return read.usage.inputUnits + 2 * read.usage.outputUnits;
}
