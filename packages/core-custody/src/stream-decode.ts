// SPDX-License-Identifier: AGPL-3.0-only
//
// OpenRouter's stream, decoded inside custody (#1508), for a destination that
// declares `stream: 'openai_sse'`. Custody presents a key there, and an answer
// may echo it split across events, so the raw stream never leaves custody:
//
// 1. Events. Complete server-sent events are split on blank lines; comment
//    lines (`: OPENROUTER PROCESSING`) are skipped; `data: [DONE]` ends it.
//    Each `data:` payload is parsed as JSON and redacted as JSON, so a key in
//    any one field is caught whatever its escaping.
// 2. Decoded content. Each event's `choices[0].delta.content` joins one
//    decoded text, which the holding redactor reads: the text joined so far,
//    redacted, goes out as a piece except its last H characters, held back
//    for the next event. H is the longest spelling the redacter knows, so a
//    key split across events is joined before it is redacted, and no spelling
//    can cross a piece's edge.
// 3. The folded body: `{ model, content, finish_reason, usage, error }` from the
//    redacted events, `content` the whole redacted text, redacted as JSON once more.
//
// A payload out of shape anywhere a choice is read (`readable`), or a stream
// cut mid-event or before `[DONE]`, folds to `{ error: 'stream_malformed' }`;
// a stream that reports a second model or a second, different usage folds to
// `stream_contradicted`; an error once reported stays, and so does the worst
// finish (`error`, then any other, then `stop`). The adapter reads each as held.
// It imports no connector code, as custody's process loads it.

import { StringDecoder } from 'node:string_decoder';
import type { StoredCredential } from './credentials.ts';
import { longestSpelling, redact, redactedValue, redacterOf, secretsOf } from './redaction.ts';

export interface StreamDecode {
  /** The display texts this chunk lets out, redacted. */
  push(chunk: Buffer): readonly string[];
  /** The texts still held, and the folded body. */
  end(): { readonly pieces: readonly string[]; readonly body: string };
}

interface Folded {
  model: unknown;
  finishReason: unknown;
  usage: unknown;
  error: unknown;
  /** A later event said otherwise of the model or the usage. */
  contradicted: boolean;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The first choice of an event, as OpenRouter's chat chunks carry it. */
const choiceOf = (event: Record<string, unknown>): Record<string, unknown> =>
  record(Array.isArray(event['choices']) ? event['choices'][0] : undefined);

/** One event's `data:` lines, joined; undefined for an event that carries none. */
function dataOf(event: string): string | undefined {
  const lines = event
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /u, ''));
  return lines.length === 0 ? undefined : lines.join('\n');
}

/** A finish's rank: `stop` 0, `error` 2, any other (`length`, `cancelled`) 1. */
const rank = (finish: unknown): number => (finish === 'stop' ? 0 : finish === 'error' ? 2 : 1);

/** `finish` is worse than the one folded so far, or none is folded. */
const worse = (finish: unknown, folded: unknown): boolean =>
  folded === null || rank(finish) > rank(folded);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * An event read whole: an object; its choices, where present, a list of
 * objects; the first one's delta, where present, an object, its content text
 * or null, and its finish a name or null. Anything else is no stream read whole.
 */
function readable(event: unknown): boolean {
  if (!isObject(event)) return false;
  const { choices } = event;
  if (choices === undefined) return true;
  if (!Array.isArray(choices) || !choices.every((choice) => isObject(choice))) return false;
  const first = choices[0] as Record<string, unknown> | undefined;
  if (first === undefined) return true;
  const { delta, finish_reason: finish } = first;
  if (delta !== undefined && !isObject(delta)) return false;
  const content = delta?.['content'];
  return (
    (content === undefined || content === null || typeof content === 'string') &&
    (finish === undefined || finish === null || typeof finish === 'string')
  );
}

/** A value already folded that a later event says otherwise of. */
const contradicts = (was: unknown, now: unknown): boolean =>
  was !== null && JSON.stringify(was) !== JSON.stringify(now);

/**
 * One event folded in. What the stream reported stays reported: an error, an
 * error finish, a second model or a second, different usage is never undone
 * by a later event, and folds to an error, so the call is held.
 */
function fold(folded: Folded, seen: Record<string, unknown>): void {
  if (seen['model'] !== undefined) {
    if (contradicts(folded.model, seen['model'])) folded.contradicted = true;
    folded.model = seen['model'];
  }
  if (seen['usage'] !== undefined && seen['usage'] !== null) {
    if (contradicts(folded.usage, seen['usage'])) folded.contradicted = true;
    folded.usage = seen['usage'];
  }
  if (seen['error'] !== undefined && seen['error'] !== null && folded.error === null) {
    folded.error = seen['error'];
  }
  // The worst finish reported stays: `error` over any other, any other over `stop`.
  const finish = choiceOf(seen)['finish_reason'];
  if (finish !== undefined && finish !== null && worse(finish, folded.finishReason)) {
    folded.finishReason = finish;
  }
}

// oxlint-disable-next-line max-lines-per-function -- one decoder's state and its two steps
export function openaiSse(credential: StoredCredential): StreamDecode {
  const secrets = secretsOf(credential);
  const redactText = redacterOf(secrets);
  const hold = longestSpelling(secrets);
  const decoder = new StringDecoder('utf8');
  const folded: Folded = {
    model: null,
    finishReason: null,
    usage: null,
    error: null,
    contradicted: false,
  };
  let buffer = '';
  let tail = '';
  let content = '';
  let done = false;
  let malformed = false;
  /** An event read and skipped: the pieces go on, the folded body is malformed. */
  let unreadable = false;

  /** The redacted text so far less what is held back; `all` lets the tail go too. */
  const release = (added: string, all: boolean): readonly string[] => {
    const text = redactText(tail + added);
    let cut = all ? text.length : Math.max(0, text.length - hold);
    // Never between the halves of a surrogate pair: a piece is whole text.
    if (cut > 0 && cut < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(cut - 1))) cut -= 1;
    tail = text.slice(cut);
    const out = text.slice(0, cut);
    content += out;
    return out === '' ? [] : [out];
  };

  const take = (event: string): string => {
    const data = dataOf(event);
    if (data === undefined || done || malformed) return '';
    if (data.trim() === '[DONE]') {
      done = true;
      return '';
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      malformed = true;
      return '';
    }
    const raw = record(parsed);
    const seen = record(redactedValue(parsed, redactText));
    fold(folded, seen);
    // The decoded text is read unredacted here: the holding redactor sees it joined.
    const delta = record(choiceOf(raw)['delta'])['content'];
    if (!readable(parsed)) unreadable = true;
    return typeof delta === 'string' ? delta : '';
  };

  return {
    push: (chunk) => {
      buffer += decoder.write(chunk);
      const events = buffer.split(/\r?\n\r?\n/u);
      buffer = events.pop() ?? '';
      return release(events.map((event) => take(event)).join(''), false);
    },
    end: () => {
      buffer += decoder.end();
      const added = buffer.trim() === '' ? '' : take(buffer);
      if (buffer.trim() !== '' && !done) malformed = true;
      const pieces = release(added, true);
      if (!done) malformed = true;
      const usage = record(folded.usage);
      const body = {
        model: folded.model,
        content,
        finish_reason: folded.finishReason,
        usage: {
          prompt_tokens: usage['prompt_tokens'] ?? null,
          completion_tokens: usage['completion_tokens'] ?? null,
          cost: usage['cost'] ?? null,
        },
        error:
          malformed || unreadable
            ? 'stream_malformed'
            : folded.contradicted
              ? 'stream_contradicted'
              : folded.error,
      };
      return { pieces, body: redact(JSON.stringify(body), credential) };
    },
  };
}
