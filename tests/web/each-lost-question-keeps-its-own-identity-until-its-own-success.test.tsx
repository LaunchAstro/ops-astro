// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A tab can hold more than one question whose answer was lost, and each keeps
// the identity it first went with until a success of that identity: resent,
// each replays its own first attempt. A success ends that identity for good,
// so a replay of it that loses its answer late never brings it back, and the
// same question asked afresh afterwards is a new question.

import { afterEach, expect, it } from 'vitest';
import { resends, type Asked } from '../../apps/web/src/assistant/resend.ts';
import type { CallResult } from '../../apps/web/src/operations/client.ts';
import { unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import { drawer, identities, standIn } from './resend-fixture.tsx';

afterEach(unmountAll);

it('a second lost question replays its own first attempt while the first lost one is still kept', async () => {
  const api = standIn({ 'conversation.message': ['drop', 'drop'] });
  await (
    await drawer(api.client)
  )('First question', 'Question A', 'Question B', 'Question B', 'Question A');
  const messages = identities(api.sent, 'conversation.message');
  expect(messages).toHaveLength(4);
  expect(messages[2], 'B resent under its first identity').toBe(messages[1]);
  expect(messages[3], 'A resent under its first identity').toBe(messages[0]);
  expect(api.committed).toEqual([
    'conversation.start',
    'conversation.message',
    'conversation.message',
  ]);
});

const lost = { unavailable: true } as unknown as CallResult<unknown>;
const done = { ok: true, value: {} } as unknown as CallResult<unknown>;

/** A write the test settles by hand, recording the identity it was sent under. */
function writes() {
  const sent: string[] = [];
  const pending: ((result: CallResult<unknown>) => void)[] = [];
  const write = async (_request: Asked['request'], operationId: string) => {
    sent.push(operationId);
    return await new Promise<CallResult<unknown>>((resolve) => {
      pending.push(resolve);
    });
  };
  return {
    sent,
    write,
    settle: (at: number, result: CallResult<unknown>) => pending[at]?.(result),
  };
}

it('a replay that loses its answer after another replay of it succeeded does not bring the identity back', async () => {
  const tab = resends();
  const asked: Asked = {
    command: 'conversation.start',
    question: 'What is due today?',
    request: {},
  };
  const w = writes();
  const first = tab.send('tab', asked, w.write);
  w.settle(0, lost);
  await first;
  const late = tab.send('tab', asked, w.write);
  const quick = tab.send('tab', asked, w.write);
  w.settle(2, done);
  await quick;
  w.settle(1, lost);
  await late;
  const again = tab.send('tab', asked, w.write);
  w.settle(3, done);
  await again;
  expect(w.sent.slice(0, 3), 'both replays went under the first identity').toEqual([
    w.sent[0],
    w.sent[0],
    w.sent[0],
  ]);
  expect(w.sent[3], 'asked afresh after a success: a new question').not.toBe(w.sent[0]);
});
