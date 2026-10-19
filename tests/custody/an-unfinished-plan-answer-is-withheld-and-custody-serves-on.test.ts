// SPDX-License-Identifier: AGPL-3.0-only
//
// #1620 P3: only a stream that ends in a completed response is answered.
// A malformed, interrupted, incomplete, failed or over-deep answer is
// withheld under one named result, with its kind in the log, nothing thrown,
// and the next answer still folded: custody keeps serving.

import { expect, it } from 'vitest';
import type { Outbound } from '../../packages/core-custody/src/egress-answer.ts';
import { planAnswer, type PlanAnswerLog } from '../../packages/core-custody/src/plan-answer.ts';
import { SECRETS, answered, completed, sse, stream } from './fixtures/plan-answer-world.ts';

const GOOD = answered(stream(completed(['all done'])));

function withheldAs(outcome: Outbound, kind: PlanAnswerLog): void {
  const log: PlanAnswerLog[] = [];
  expect(planAnswer(outcome, SECRETS, (seen) => log.push(seen))).toEqual({
    ok: false,
    code: 'SUBSCRIPTION_ANSWER_WITHHELD',
    words: expect.any(String),
  });
  expect(log).toEqual([kind]);
  // The same holder goes on: the next good answer folds.
  expect(planAnswer(GOOD, SECRETS)).toMatchObject({ ok: true });
}

const created = { type: 'response.created', response: { id: 'r', status: 'in_progress' } };

it('withholds a malformed answer', () => {
  const malformed = 'plan answer withheld: malformed';
  withheldAs(answered(`${sse([created])}data: {"type":\n\n${stream(completed(['x']))}`), malformed);
  withheldAs(answered(`${stream(completed(['x']))}data: [DONE]\n\n`), malformed);
  withheldAs(answered(stream(completed(['x'])), 'application/json'), malformed);
  withheldAs({ ...answered(stream(completed(['x']))), notUtf8: true }, malformed);
  withheldAs(answered(sse([created, { type: 'response.completed', response: 'done' }])), malformed);
  withheldAs(answered(sse([created, { type: 'response.completed', response: [1] }])), malformed);
  withheldAs(answered(`${stream(completed(['x']))}${sse([created])}`), malformed);
});

it('withholds an interrupted answer', () => {
  const interrupted = 'plan answer withheld: interrupted';
  withheldAs(
    answered(sse([created, { type: 'response.output_text.delta', delta: 'hal' }])),
    interrupted,
  );
  withheldAs(answered(''), interrupted);
  withheldAs({ ok: false, fault: 'timeout', status: 200 }, interrupted);
  withheldAs({ ok: false, fault: 'network', status: null }, interrupted);
});

it('withholds an incomplete or failed answer', () => {
  withheldAs(
    answered(stream({ ...completed(['half']), status: 'incomplete' }, [], 'response.incomplete')),
    'plan answer withheld: incomplete',
  );
  withheldAs(
    answered(stream({ ...completed(['half']), status: 'incomplete' })),
    'plan answer withheld: incomplete',
  );
  withheldAs(
    answered(
      stream(
        { ...completed([]), status: 'failed', error: { code: 'server_error' } },
        [],
        'response.failed',
      ),
    ),
    'plan answer withheld: failed',
  );
  withheldAs(
    answered(sse([created, { type: 'error', code: 'server_error', message: 'boom' }])),
    'plan answer withheld: failed',
  );
  withheldAs({ ok: false, fault: 'status', status: 500 }, 'plan answer withheld: failed');
  withheldAs({ ok: false, fault: 'too_large', status: 200 }, 'plan answer withheld: failed');
  withheldAs({ ok: false, fault: 'redirect', status: 302 }, 'plan answer withheld: failed');
});

it('withholds an over-deep answer without walking it, and serves on', () => {
  const levels = 200_000;
  const deep = `${'{"a":'.repeat(levels)}1${'}'.repeat(levels)}`;
  const body = `event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":${deep}}}\n\n`;
  withheldAs(answered(body), 'plan answer withheld: too deep');
  const justDeep = `${'['.repeat(70)}"x"${']'.repeat(70)}`;
  withheldAs(
    answered(stream({ ...completed(['x']), extra: JSON.parse(justDeep) as unknown })),
    'plan answer withheld: too deep',
  );
});

it('reads the stream as a conforming event reader does', () => {
  const done = stream(completed(['x']));
  const failed = sse([{ type: 'response.failed', response: { status: 'failed' } }]);
  withheldAs(answered(`${done.slice(0, -1)}\r${failed}`), 'plan answer withheld: malformed');
  withheldAs(answered(done.slice(0, -1)), 'plan answer withheld: interrupted');
  withheldAs(answered(`${done}data: {"type":"resp`), 'plan answer withheld: interrupted');
  withheldAs(
    answered(done.replace('event: response.completed', 'event: response.failed')),
    'plan answer withheld: malformed',
  );
  for (const ending of ['\r\n', '\r'])
    expect(planAnswer(answered(done.replaceAll('\n', ending)), SECRETS)).toMatchObject({
      ok: true,
    });
});
