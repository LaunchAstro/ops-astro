// SPDX-License-Identifier: AGPL-3.0-only
//
// Synthetic plan answers for the Responses fold's tests (#1620 P3): two
// planted secrets with no dictionary words in them, a server-sent event
// writer, a completed response with chosen output parts, and a check that no
// run of a planted secret appears in some text.

import type { Outbound } from '../../../packages/core-custody/src/egress-answer.ts';

// Joined at runtime so no source line holds a whole key-shaped literal.
export const ACCESS: string = [
  'Hm4Rt8',
  'LwQv7K',
  'p2ZxBn',
  '3Yc6Df',
  'Jz5Ug1',
  'EsWq9X',
  'o2Ka',
].join('');
export const REFRESH = 'Pn7Tg2VbXc4Mk9Rs6Ld1Qw8Fz3Hy5Jt0Nu';
export const SECRETS: readonly string[] = [ACCESS, REFRESH];

/** One server-sent event per value, as the Responses stream writes them. */
export const sse = (events: readonly Record<string, unknown>[]): string =>
  events.map((event) => `event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`).join('');

/** A completed response whose one message holds these output text parts, in order. */
export function completed(
  texts: readonly string[],
  extra: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    id: 'resp_synthetic',
    object: 'response',
    status: 'completed',
    model: 'gpt-6.1-sol',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: texts.map((text) => ({ type: 'output_text', text, annotations: [] })),
      },
      ...extra,
    ],
    usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 },
  };
}

/** A whole stream: created, the given deltas, then the terminal event. */
export function stream(
  response: Record<string, unknown>,
  deltas: readonly string[] = [],
  terminal = 'response.completed',
): string {
  return sse([
    { type: 'response.created', response: { id: 'resp_synthetic', status: 'in_progress' } },
    ...deltas.map((delta) => ({ type: 'response.output_text.delta', output_index: 0, delta })),
    { type: terminal, response },
  ]);
}

/** A 200 event stream as egress answers it. */
export const answered = (body: string, mediaType = 'text/event-stream'): Outbound => ({
  ok: true,
  status: 200,
  body,
  mediaType,
});

/** The planted secret's runs of `length` characters that appear in the text. */
export function runsIn(text: string, length = 4): readonly string[] {
  return SECRETS.flatMap((secret) =>
    Array.from({ length: secret.length - length + 1 }, (_, at) => secret.slice(at, at + length)),
  ).filter((run) => text.includes(run));
}

/** The secret cut into pieces of `size` characters, in a fixed scrambled order. */
export function scrambled(secret: string, size: number): readonly string[] {
  const pieces = Array.from({ length: Math.ceil(secret.length / size) }, (_, at) =>
    secret.slice(at * size, at * size + size),
  );
  return [
    ...pieces.filter((_, at) => at % 2 === 1),
    ...pieces.filter((_, at) => at % 2 === 0).toReversed(),
  ];
}
