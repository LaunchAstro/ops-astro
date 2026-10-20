// SPDX-License-Identifier: AGPL-3.0-only
//
// The stream the owner's plan sends today (register 284, OA-Plan-Staging's
// diagnostic call to gpt-6.1-sol on 20 Oct 2026): HTTP 200 with no
// content-type header, and a `response.completed` whose output is empty. The
// words come only in `response.output_item.done`. Custody answers it from
// those items, judged as any answer is; a wrong media type is still withheld.

import { expect, it } from 'vitest';
import { readChatgptPlanAnswer } from '../../packages/core-connectors/src/index.ts';
import type { Outbound } from '../../packages/core-custody/src/egress-answer.ts';
import { planAnswer } from '../../packages/core-custody/src/plan-answer.ts';
import { ACCESS, SECRETS, answered, completed, sse } from './fixtures/plan-answer-world.ts';

const WORDS = 'Open weekdays 8 to 5.';

const message = (text: string): Record<string, unknown> => ({
  id: 'msg_1',
  type: 'message',
  status: 'completed',
  role: 'assistant',
  content: [{ type: 'output_text', text, annotations: [] }],
});

/** The recorded event order: ten events, the completed response's output empty. */
function recorded(items: readonly Record<string, unknown>[]): string {
  const part = { type: 'output_text', text: '', annotations: [] };
  return sse([
    { type: 'response.created', response: { id: 'resp_synthetic', status: 'in_progress' } },
    { type: 'response.in_progress', response: { id: 'resp_synthetic', status: 'in_progress' } },
    ...items.flatMap((item, at) => [
      { type: 'response.output_item.added', output_index: at, item: { ...item, content: [] } },
      { type: 'response.content_part.added', output_index: at, content_index: 0, part },
      { type: 'response.output_text.delta', output_index: at, content_index: 0, delta: 'x' },
      { type: 'response.metadata' },
      { type: 'response.output_text.done', output_index: at, content_index: 0, text: 'x' },
      { type: 'response.content_part.done', output_index: at, content_index: 0, part },
      { type: 'response.output_item.done', output_index: at, item },
    ]),
    { type: 'response.completed', response: { ...completed([]), output: [] } },
  ]);
}

/** A 200 answer as egress gives it when the plan sends no content-type. */
const untyped = (body: string): Outbound => ({ ok: true, status: 200, body });

it('a 200 stream with no media type is answered with the words of its done items', () => {
  const kinds: string[] = [];
  const result = planAnswer(untyped(recorded([message(WORDS)])), SECRETS, (kind) =>
    kinds.push(kind),
  );
  if (!result.ok) throw new Error(result.code);
  expect(readChatgptPlanAnswer(result.response)).toMatchObject({ text: WORDS });
  expect(kinds).toEqual(['plan answer completed']);
});

it('a stream with a media type other than an event stream is still withheld', () => {
  const body = recorded([message(WORDS)]);
  const typed = { ok: true, status: 200, body, mediaType: 'application/json' } as const;
  const kinds: string[] = [];
  expect(planAnswer(typed, SECRETS, (kind) => kinds.push(kind))).toMatchObject({
    ok: false,
    code: 'SUBSCRIPTION_ANSWER_WITHHELD',
  });
  expect(kinds).toEqual(['plan answer withheld: malformed']);
});

/** Why `planAnswer` withholds the body, sent as an event stream, as its one log line names it. */
function withheld(body: string): string[] {
  const kinds: string[] = [];
  const result = planAnswer(answered(body), SECRETS, (kind) => kinds.push(kind));
  expect(result).toMatchObject({ ok: false, code: 'SUBSCRIPTION_ANSWER_WITHHELD' });
  return kinds;
}

it('words folded from the items are judged against the secrets', () => {
  const echo = `upstream echoed ${ACCESS.slice(0, 12)}`;
  expect(withheld(recorded([message(echo)]))).toEqual(['plan answer withheld: secret fragment']);
  const result = planAnswer(untyped(recorded([message(echo)])), SECRETS);
  expect(JSON.stringify(result)).not.toContain(ACCESS.slice(0, 12));
});

it('items folded into the answer keep the closed shape, or the answer is withheld', () => {
  const misshapen = [
    [{ ...message(WORDS), type: 'web_search_call' }],
    [{ ...message(WORDS), role: 'user' }],
  ];
  for (const items of misshapen)
    expect(withheld(recorded(items))).toEqual(['plan answer withheld: malformed']);
});

it('a done item without a whole-number place, or twice in one place, withholds the answer', () => {
  const body = recorded([message(WORDS)]);
  const done = `"type":"response.output_item.done","output_index":0`;
  const twice = recorded([message(WORDS), message(WORDS)]).replace(
    `"type":"response.output_item.done","output_index":1`,
    done,
  );
  const bodies = ['"1.5"', '-1', '1'].map((place) =>
    body.replace(done, done.replace(':0', `:${place}`)),
  );
  for (const each of [...bodies, twice])
    expect(withheld(each)).toEqual(['plan answer withheld: malformed']);
});

it('a completed output that names its items is answered from it, not from the item events', () => {
  const body = recorded([message('from the events')]).replace(
    '"output":[]',
    `"output":${JSON.stringify([message(WORDS)])}`,
  );
  const result = planAnswer(untyped(body), SECRETS);
  if (!result.ok) throw new Error(result.code);
  expect(readChatgptPlanAnswer(result.response)).toMatchObject({ text: WORDS });
});
