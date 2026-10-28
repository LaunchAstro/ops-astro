// SPDX-License-Identifier: AGPL-3.0-only
//
// Hermes Agent (#2270): the owner's own agent on the M5, which he chats with
// from the side panel. Owner decision, 28 October 2026: it may act on the M5
// with its own tools, for his own chats only. Ops Astro still never acts on a
// reply: it is text the server keeps.
//
// It listens on the M5's loopback with an OpenAI-shaped chat, so the model
// agent's custody calls it there under its key and decodes its stream as it
// does OpenRouter's (`stream-decode.ts`), folding it into one body. The call
// never leaves the M5, and moves no money: it is unpriced, and offered only to
// the people `OPS_HERMES_PEOPLE` lists, never on a client's task.
//
// The request is the conversation's own words only: the earlier turns and the
// typed message. No instructions, and no page or task text, which other people
// may have written.

import { earlierTurns, type Turn } from './ollama.ts';
import {
  readModelId,
  type AdapterRequest,
  type ModelAnswer,
  type ModelOperationDeclaration,
} from './operation.ts';
import { CONVERSATION_ANSWER } from './replay.ts';

export const HERMES_PROVIDER: string = 'hermes';
export const HERMES_CONVERSATION_KEY: string = 'model.conversation_answer_hermes';
/** The one model Hermes Agent answers as. */
export const HERMES_MODEL = 'hermes-agent';
export const HERMES_PATH = '/v1/chat/completions';
/** The request body's most, in bytes: the context is trimmed to fit it. */
export const HERMES_BODY_LIMIT: number = 48 * 1024;

/** The conversation's own turns and the typed message, streamed, and nothing else. */
export function hermesRequest(values: Readonly<Record<string, string>>): AdapterRequest {
  const messages: readonly Turn[] = [
    ...earlierTurns(values['earlier']),
    { role: 'user', content: values['message'] ?? '' },
  ];
  return {
    path: HERMES_PATH,
    method: 'POST',
    body: JSON.stringify({ model: HERMES_MODEL, messages, stream: true }),
  };
}

/** A count the stream reported, or nothing where it reported none; undefined when out of shape. */
function units(value: unknown): number | undefined {
  if (value === undefined || value === null) return 0;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Custody's folded body, `{ model, content, finish_reason, usage, error }`, as
 * one answer; undefined (held) for an error, any finish but `stop` (Hermes
 * Agent's `cancelled`, `length` and `error` included), no text, or a model or
 * a count out of shape.
 */
export function readHermesAnswer(body: unknown): ModelAnswer | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const shape = body as Record<string, unknown>;
  if (shape['error'] !== null && shape['error'] !== undefined) return undefined;
  const { content } = shape;
  if (shape['finish_reason'] !== 'stop' || typeof content !== 'string' || content === '') {
    return undefined;
  }
  const usage = shape['usage'];
  const counts = typeof usage === 'object' && usage !== null ? usage : {};
  const input = units((counts as Record<string, unknown>)['prompt_tokens']);
  const output = units((counts as Record<string, unknown>)['completion_tokens']);
  const model = readModelId(shape['model']);
  if (input === undefined || output === undefined || model === undefined) return undefined;
  return {
    text: content,
    model,
    usage: { inputUnits: input, outputUnits: output },
    providerCode: null,
  };
}

/** The price of an answer on the owner's own machine and plan: nothing. */
export function hermesCostMinor(_answer: ModelAnswer): number {
  return 0;
}

/** A person's message in their own conversation, answered by Hermes Agent on the M5. */
export const HERMES_CONVERSATION: ModelOperationDeclaration = {
  key: HERMES_CONVERSATION_KEY,
  provider: HERMES_PROVIDER,
  destination: 'hermes',
  fields: CONVERSATION_ANSWER.fields,
  answer: readHermesAnswer,
  // The panel's bound, as Ollama's.
  timeoutMs: 120_000,
  // Raw stream bytes, counted by custody before it decodes them.
  maxResponseBytes: 512 * 1024,
  maximumMinor: 0,
  settlesAt: 'completed',
  // Hermes Agent's refusals before any work: a body it cannot read, the key, a busy server.
  nothingHappened: ['http_400', 'http_401', 'http_403', 'http_404', 'http_429'],
  billed: false,
  // One agent run at a time per business.
  concurrency: 1,
};
