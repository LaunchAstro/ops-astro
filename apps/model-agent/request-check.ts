// SPDX-License-Identifier: AGPL-3.0-only
//
// The one request the model agent sends Ollama: a streamed chat, thinking
// off, with an offered model, to `/api/chat` by POST, within the wait and
// answer size the catalogue gives an Ollama chat. Anything else is refused
// before custody sees it.

import { OLLAMA_MODELS, OLLAMA_PATH } from '../../packages/core-connectors/src/index.ts';
import type { OutboundRequest } from '../../packages/core-custody/src/agent.ts';

/** The longest wait and the largest answer the catalogue gives an Ollama chat. */
const LONGEST_MS = 120_000;
const LARGEST_BYTES = 256 * 1024;

export const same = (keys: string, wanted: string): boolean =>
  keys === wanted.split(',').toSorted().join();

export const keysOf = (value: object): string => Object.keys(value).toSorted().join();

/** The one request the agent sends: a streamed chat with an offered model, within the catalogue's bounds. */
export function chatOf(request: unknown): OutboundRequest | undefined {
  if (typeof request !== 'object' || request === null) return undefined;
  const asked = request as OutboundRequest;
  if (
    !same(keysOf(asked), 'body,destination,maxResponseBytes,method,path,timeoutMs') ||
    asked.destination !== 'ollama' ||
    asked.method !== 'POST' ||
    asked.path !== OLLAMA_PATH ||
    !Number.isSafeInteger(asked.timeoutMs) ||
    asked.timeoutMs < 1 ||
    asked.timeoutMs > LONGEST_MS ||
    !Number.isSafeInteger(asked.maxResponseBytes) ||
    asked.maxResponseBytes < 1 ||
    asked.maxResponseBytes > LARGEST_BYTES ||
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
  const { model, messages, stream, think } = chat as Record<string, unknown>;
  const offered = (OLLAMA_MODELS as readonly unknown[]).includes(model);
  const ok =
    same(keysOf(chat), 'messages,model,stream,think') && stream === true && think === false;
  return ok && offered && Array.isArray(messages) ? asked : undefined;
}
