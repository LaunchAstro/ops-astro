// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's ChatGPT plan's answer as custody gives it back (#1620): the
// Responses stream, read whole, folded to its completed response, and only
// then redacted with the call's secrets. A token split across two delta
// events is absent from the raw stream but joined in the completed
// response's text, so it is redacted where it is joined; the deltas never
// leave custody. Only a `response.completed` event whose response is
// `completed` folds: no terminal event, a failed or incomplete response, or
// malformed JSON folds to nothing, which custody answers as withheld.

import type { StoredCredential } from './credentials.ts';
import type { Outbound } from './egress-answer.ts';
import { redactedValue, redacterOf } from './redaction.ts';

/** The deepest nesting a plan answer may have; a Responses answer is a few levels deep. */
const MOST_DEPTH = 64;

/** Whether a parsed value nests deeper than MOST_DEPTH, judged from its own list, not the call stack. */
function tooDeep(value: unknown): boolean {
  const pending: [unknown, number][] = [[value, 0]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [item, depth] = next;
    if (typeof item !== 'object' || item === null) continue;
    if (depth >= MOST_DEPTH) return true;
    for (const child of Object.values(item)) pending.push([child, depth + 1]);
  }
  return false;
}

/**
 * The completed response of a whole Responses stream, as JSON text, or
 * undefined; undefined too when it nests deeper than MOST_DEPTH, which
 * nothing below then walks or writes.
 */
export function foldResponses(stream: string): string | undefined {
  for (const block of stream.split(/\r?\n\r?\n/u)) {
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    const shape = event as { type?: unknown; response?: unknown } | null;
    if (shape?.type !== 'response.completed') continue;
    const response = shape.response as { status?: unknown } | null | undefined;
    if (typeof response !== 'object' || response === null || Array.isArray(response))
      return undefined;
    if (tooDeep(response)) return undefined;
    return response.status === 'completed' ? JSON.stringify(response) : undefined;
  }
  return undefined;
}

/** Every string in a parsed value, in document order. */
function stringsOf(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) stringsOf(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      into.push(key);
      stringsOf(item, into);
    }
  }
  return into;
}

/** The output text a reader joins: every `output_text` part's text, in order. */
function outputText(response: unknown): string {
  const output = (response as { output?: unknown } | null)?.output;
  if (!Array.isArray(output)) return '';
  return output
    .flatMap((item) => (item as { content?: unknown } | null)?.content ?? [])
    .map((part) => part as { type?: unknown; text?: unknown } | null)
    .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part) => String(part?.text))
    .join('');
}

/**
 * The completed response with every spelling of each secret redacted, or
 * undefined. Each string is redacted alone, and then what a reader can join
 * is judged whole: the output text parts together, and every string in
 * order. A secret split between two strings shows only there, so the answer
 * is withheld rather than passed on.
 */
export function foldedAndRedacted(stream: string, secrets: readonly string[]): string | undefined {
  const folded = foldResponses(stream);
  if (folded === undefined) return undefined;
  const redactText = redacterOf(secrets);
  const redacted = redactedValue(JSON.parse(folded), redactText);
  const joined = [outputText(redacted), stringsOf(redacted).join('')];
  if (joined.some((text) => redactText(text) !== text)) return undefined;
  return JSON.stringify(redacted);
}

/** Custody's reply for a `responses_sse` answer: folded and redacted, or withheld as malformed. */
export function foldedReply(
  outcome: Outbound & { ok: true },
  secrets: readonly string[],
  credential: Pick<StoredCredential, 'kind' | 'account'>,
): Record<string, unknown> {
  let folded: string | undefined;
  try {
    folded = foldedAndRedacted(outcome.body, secrets);
  } catch {
    // Whatever the answer held, custody withholds it and goes on serving.
    folded = undefined;
  }
  return folded === undefined
    ? { type: 'withheld', reason: 'malformed' }
    : {
        type: 'answer',
        outcome: { ...outcome, body: folded },
        kind: credential.kind,
        account: credential.account,
      };
}
