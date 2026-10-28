// SPDX-License-Identifier: AGPL-3.0-only
//
// The `ollama` provider: a model run by Ollama on the same machine as the API
// (on the M5, Qwen and Gemma), for the side panel's conversation. The broker
// reaches it like any destination: custody sends the request to Ollama's
// `/api/chat` on loopback, and the API's composition root refuses an Ollama
// route that is not local or whose destination is not this machine, so the
// port is never reached over a network. Ollama asks for no key; its credential
// is filed as `none` and custody presents nothing. Only then is the chat
// streamed: the answer settles from the whole stream folded
// (`foldOllamaStream`) and shows as it comes through the piece reader
// (`ollamaPieces`). Under a credential custody sends, the answer comes whole,
// so custody's redaction reads every word of it at once.
//
// The model runs on hardware already paid for, so every answer costs nothing
// and the operation is unpriced, as the conversation seam requires (#1508, option B).

import { conversationInstructions, promptPage, promptSites } from './conversation-prompt.ts';
import {
  readModelId,
  type AdapterRequest,
  type ModelAnswer,
  type ModelOperationDeclaration,
  type PieceReader,
} from './operation.ts';
import { CONVERSATION_ANSWER } from './replay.ts';

/** The provider's key in routes and operations; the setting's value is `ollama`. */
export const OLLAMA_PROVIDER = 'ollama';

export const OLLAMA_PATH = '/api/chat';

/**
 * The models offered, the default first, each as Ollama names it on the M5:
 * the Qwen mixture of experts (about five times the dense model's speed on the
 * M5, 15 Oct), then the dense Qwen, then Gemma.
 */
export const OLLAMA_MODELS = ['qwen3.6:35b-mlx', 'qwen3.6:27b-mlx', 'gemma4:31b-mlx'] as const;
export const OLLAMA_DEFAULT_MODEL: string = OLLAMA_MODELS[0];

export interface Turn {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

const ROLES: Readonly<Record<string, Turn['role']>> = { person: 'user', agent: 'assistant' };

/** The earlier messages (`conversation-context.ts`, a JSON list of `{ role, body }`) as chat turns; none if unreadable. */
export function earlierTurns(earlier: string | undefined): readonly Turn[] {
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

/**
 * The adapter: fields in, one chat for the model asked for (the default unless
 * named), streamed only when the broker says custody presents no credential.
 */
export function ollamaAdapter(
  values: Readonly<Record<string, string>>,
  _operationId?: string,
  model: string = OLLAMA_DEFAULT_MODEL,
  streamed = false,
): AdapterRequest {
  const messages: readonly Turn[] = [
    {
      role: 'system',
      content: conversationInstructions(promptPage(values['page']), promptSites(values['page'])),
    },
    ...earlierTurns(values['earlier']),
    { role: 'user', content: values['message'] ?? '' },
  ];
  return {
    path: OLLAMA_PATH,
    method: 'POST',
    body: JSON.stringify({ model, messages, stream: streamed, think: false }),
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

/** One NDJSON line of a streamed chat as an object, or undefined when it is not one. */
function lineOf(text: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A line's piece of the reply's words: its `message.content`, when that is text. */
function contentOf(line: Record<string, unknown>): string | undefined {
  const { message } = line;
  if (typeof message !== 'object' || message === null) return undefined;
  const { content } = message as Record<string, unknown>;
  return typeof content === 'string' ? content : undefined;
}

/**
 * A streamed chat's whole body (one JSON object per line, the last `done`)
 * as the one answer a chat not streamed gives: every line's words joined, and
 * the last line's model and counts. Undefined when any line is unreadable or
 * not the last line ends it, so the answer reader finds no answer.
 */
export function foldOllamaStream(body: string): string | undefined {
  const lines = body.split('\n').filter((text) => text.trim() !== '');
  const read = lines.map((text) => lineOf(text));
  const words = read.map((line) => (line === undefined ? undefined : contentOf(line)));
  const last = read.at(-1);
  if (last === undefined || words.some((word) => word === undefined)) return undefined;
  if (read.slice(0, -1).some((line) => line?.['done'] === true)) return undefined;
  const content = words.join('');
  return JSON.stringify({ ...last, message: { role: 'assistant', content } });
}

const OPENER = '<think>';
const CLOSER = '</think>';

/**
 * Display texts from a streamed chat as its bytes arrive, in order and
 * complete: whole lines only, each line's words, and a leading thinking block
 * held back until it closes and never shown. Leading white space is dropped,
 * as the settled answer drops it. A line that is not a reply piece shows
 * nothing, and nothing after the `done` line is shown: the fold refuses it.
 */
export function ollamaPieces(): PieceReader {
  const decoder = new TextDecoder();
  let partial = '';
  // `start` until the words show whether they open with a thinking block.
  let phase: 'start' | 'thinking' | 'answer' = 'start';
  let held = '';
  let started = false;
  let finished = false;
  const shown = (words: string): string => {
    if (phase === 'answer') return words;
    held += words;
    if (phase === 'start') {
      const leading = held.trimStart();
      if (OPENER.startsWith(leading) && leading !== OPENER) return '';
      if (!leading.startsWith(OPENER)) {
        phase = 'answer';
        return held;
      }
      phase = 'thinking';
    }
    const end = held.indexOf(CLOSER);
    if (end === -1) return '';
    phase = 'answer';
    return held.slice(end + CLOSER.length);
  };
  return {
    push: (chunk) => {
      partial += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      const texts: string[] = [];
      for (const text of lines) {
        const line = finished ? undefined : lineOf(text);
        finished ||= line?.['done'] === true;
        const words = line === undefined ? undefined : contentOf(line);
        const out = words === undefined ? '' : shown(words);
        const trimmed = started ? out : out.trimStart();
        if (trimmed === '') continue;
        started = true;
        texts.push(trimmed);
      }
      return texts;
    },
  };
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
  maximumMinor: 0,
  settlesAt: 'completed',
  // Ollama's own answers before any work: a body it cannot read, or a model it does not have.
  nothingHappened: ['http_400', 'http_404'],
  billed: false,
  // One model loaded at a time on the M5, so one answer at a time per business.
  concurrency: 1,
  // Streamed: the settled answer is the whole stream folded, and pieces show as it comes.
  fold: foldOllamaStream,
  pieces: ollamaPieces,
};
