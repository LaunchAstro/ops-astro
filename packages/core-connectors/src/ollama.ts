// SPDX-License-Identifier: AGPL-3.0-only
//
// The `ollama` provider: a model run by Ollama on the same machine as the API
// (on the M5, Qwen and Gemma), for the side panel's conversation. The broker
// reaches it like any destination: custody sends the request to Ollama's
// `/api/chat` on loopback, and the API's composition root refuses an Ollama
// route that is not local or whose destination is not this machine, so the
// port is never reached over a network. Ollama asks for no key; custody sends
// the route's local token, which Ollama ignores.
//
// The model runs on hardware already paid for, so every answer costs nothing.
// The catalogue takes no priced maximum below one minor unit, so the
// operation declares that; the conversation seam holds nothing for it either way.

import { conversationInstructions } from './conversation-prompt.ts';
import {
  readModelId,
  type AdapterRequest,
  type ModelAnswer,
  type ModelOperationDeclaration,
} from './operation.ts';
import { CONVERSATION_ANSWER } from './replay.ts';

/** The provider's key in routes and operations; the setting's value is `ollama`. */
export const OLLAMA_PROVIDER = 'ollama';

export const OLLAMA_PATH = '/api/chat';

/** The models offered, the default first: Qwen, then Gemma, each as Ollama names it on the M5. */
export const OLLAMA_MODELS = ['qwen3.6:27b-mlx', 'gemma4:31b-mlx'] as const;
export const OLLAMA_DEFAULT_MODEL: string = OLLAMA_MODELS[0];

interface Turn {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

const ROLES: Readonly<Record<string, Turn['role']>> = { person: 'user', agent: 'assistant' };

/** The earlier messages (`conversation-context.ts`, a JSON list of `{ role, body }`) as chat turns; none if unreadable. */
function earlierTurns(earlier: string | undefined): readonly Turn[] {
  if (earlier === undefined || earlier === '') return [];
  let rows: unknown;
  try {
    rows = JSON.parse(earlier);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row: unknown): Turn[] => {
    if (typeof row !== 'object' || row === null) return [];
    const { role, body } = row as Record<string, unknown>;
    const mapped = typeof role === 'string' ? ROLES[role] : undefined;
    return mapped !== undefined && typeof body === 'string'
      ? [{ role: mapped, content: body }]
      : [];
  });
}

/** The page's title (`{ task, title }`), never its id; null when there is no page or no title. */
function pageTitle(page: string | undefined): string | null {
  if (page === undefined || page === '') return null;
  try {
    const { title } = JSON.parse(page) as Record<string, unknown>;
    return typeof title === 'string' && title !== '' ? title : null;
  } catch {
    return null;
  }
}

/** The adapter: fields in, one chat for the model asked for (the default unless named). */
export function ollamaAdapter(
  values: Readonly<Record<string, string>>,
  _operationId?: string,
  model: string = OLLAMA_DEFAULT_MODEL,
): AdapterRequest {
  const messages: readonly Turn[] = [
    { role: 'system', content: conversationInstructions(pageTitle(values['page'])) },
    ...earlierTurns(values['earlier']),
    { role: 'user', content: values['message'] ?? '' },
  ];
  return {
    path: OLLAMA_PATH,
    method: 'POST',
    body: JSON.stringify({ model, messages, stream: false, think: false }),
  };
}

const whole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** A thinking model may still open with its reasoning; only what follows it is the answer. */
const THINKING = /^\s*<think>[\s\S]*?<\/think>/u;

/** The answer schema: a finished chat, `{ model, message: { content }, done: true, prompt_eval_count, eval_count }`. */
export function readOllamaAnswer(body: unknown): ModelAnswer | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const shape = body as Record<string, unknown>;
  const { message, done } = shape;
  if (done !== true || typeof message !== 'object' || message === null) return undefined;
  const { content } = message as Record<string, unknown>;
  if (typeof content !== 'string') return undefined;
  const text = content.replace(THINKING, '').trim();
  if (text === '') return undefined;
  const input = shape['prompt_eval_count'];
  const output = shape['eval_count'];
  if (!whole(input) || !whole(output)) return undefined;
  const model = readModelId(shape['model']);
  if (model === undefined) return undefined;
  return { text, model, usage: { inputUnits: input, outputUnits: output }, providerCode: null };
}

/** The price of an answer on this machine: nothing. */
export function ollamaCostMinor(_answer: ModelAnswer): number {
  return 0;
}

/**
 * A person's question in their own conversation, answered by Ollama. It
 * carries the conversation operation's key, so the conversation seam reaches
 * it where the composition root catalogues it in the replay declaration's place.
 */
export const OLLAMA_CONVERSATION: ModelOperationDeclaration = {
  key: CONVERSATION_ANSWER.key,
  provider: OLLAMA_PROVIDER,
  destination: 'ollama',
  fields: CONVERSATION_ANSWER.fields,
  answer: readOllamaAnswer,
  // A cold model takes a while to load on the M5; the catalogue's longest wait.
  timeoutMs: 120_000,
  maxResponseBytes: 256 * 1024,
  maximumMinor: 1,
  settlesAt: 'completed',
  // Ollama's own answers before any work: a body it cannot read, or a model it does not have.
  nothingHappened: ['http_400', 'http_404'],
  billed: false,
  // One model loaded at a time on the M5, so one answer at a time per business.
  concurrency: 1,
};
