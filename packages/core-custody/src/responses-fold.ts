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

/** The completed response of a whole Responses stream, as JSON text, or undefined. */
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
    return response.status === 'completed' ? JSON.stringify(response) : undefined;
  }
  return undefined;
}

/** The completed response with every spelling of each secret redacted, or undefined. */
export function foldedAndRedacted(stream: string, secrets: readonly string[]): string | undefined {
  const folded = foldResponses(stream);
  if (folded === undefined) return undefined;
  return JSON.stringify(redactedValue(JSON.parse(folded), redacterOf(secrets)));
}

/** Custody's reply for a `responses_sse` answer: folded and redacted, or withheld as malformed. */
export function foldedReply(
  outcome: Outbound & { ok: true },
  secrets: readonly string[],
  credential: Pick<StoredCredential, 'kind' | 'account'>,
): Record<string, unknown> {
  const folded = foldedAndRedacted(outcome.body, secrets);
  return folded === undefined
    ? { type: 'withheld', reason: 'malformed' }
    : {
        type: 'answer',
        outcome: { ...outcome, body: folded },
        kind: credential.kind,
        account: credential.account,
      };
}
