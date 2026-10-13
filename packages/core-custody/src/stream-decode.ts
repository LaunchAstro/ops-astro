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
// A payload that is not JSON, or a stream cut mid-event or before `[DONE]`,
// folds to `{ error: 'stream_malformed' }`, which the adapter reads as held.
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

// oxlint-disable-next-line max-lines-per-function -- one decoder's state and its two steps
export function openaiSse(credential: StoredCredential): StreamDecode {
  const secrets = secretsOf(credential);
  const redactText = redacterOf(secrets);
  const hold = longestSpelling(secrets);
  const decoder = new StringDecoder('utf8');
  const folded: Folded = { model: null, finishReason: null, usage: null, error: null };
  let buffer = '';
  let tail = '';
  let content = '';
  let done = false;
  let malformed = false;

  /** The redacted text so far less what is held back; `all` lets the tail go too. */
  const release = (added: string, all: boolean): readonly string[] => {
    const text = redactText(tail + added);
    const cut = all ? text.length : Math.max(0, text.length - hold);
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
    if (seen['model'] !== undefined) folded.model = seen['model'];
    if (seen['usage'] !== undefined) folded.usage = seen['usage'];
    if (seen['error'] !== undefined) folded.error = seen['error'];
    const finish = choiceOf(seen)['finish_reason'];
    if (finish !== undefined && finish !== null) folded.finishReason = finish;
    // The decoded text is read unredacted here: the holding redactor sees it joined.
    const delta = record(choiceOf(raw)['delta'])['content'];
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
        error: malformed ? 'stream_malformed' : folded.error,
      };
      return { pieces, body: redact(JSON.stringify(body), credential) };
    },
  };
}
