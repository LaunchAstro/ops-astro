// SPDX-License-Identifier: AGPL-3.0-only
//
// The two requests the model agent sends. Ollama's: a streamed chat, thinking
// off, with an offered model, to `/api/chat` by POST, within the wait and
// answer size the catalogue gives an Ollama chat. OpenRouter's paid chat,
// exactly as the broker pins it (`openrouterRequest`), every value checked
// nested, within its declaration's wait and answer size, so nothing can widen
// what a reply may cost. Anything else is refused before custody sees it.

import { isDeepStrictEqual } from 'node:util';
import {
  OLLAMA_MODELS,
  OLLAMA_PATH,
  OPENROUTER_CONVERSATION,
  OPENROUTER_BODY_LIMIT,
  OPENROUTER_MAX_TOKENS,
  OPENROUTER_PATH,
  openrouterModel,
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
]);

const ROLES: ReadonlySet<unknown> = new Set(['system', 'user', 'assistant']);

export const same = (keys: string, wanted: string): boolean =>
  keys === wanted.split(',').toSorted().join();

export const keysOf = (value: object): string => Object.keys(value).toSorted().join();

/**
 * OpenRouter's pinned chat: an offered model at its own prices, the instructions
 * first. The body sent is the one checked: exactly its own serialisation, so no
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
    (turns[0] as Record<string, unknown> | undefined)?.['role'] === 'system';
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

/** One of the agent's two requests, within the catalogue's bounds. */
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
  if (asked.destination !== 'ollama')
    return paidChat(chat as Record<string, unknown>, asked.body) ? asked : undefined;
  const { model, messages, stream, think } = chat as Record<string, unknown>;
  const offered = (OLLAMA_MODELS as readonly unknown[]).includes(model);
  const ok =
    same(keysOf(chat), 'messages,model,stream,think') && stream === true && think === false;
  return ok && offered && Array.isArray(messages) ? asked : undefined;
}
