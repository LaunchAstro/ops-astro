// SPDX-License-Identifier: AGPL-3.0-only
//
// The hold and the admission on connections of their own, stopped at a named
// statement and failed or ended there, and the same message asked again after
// each ending:
//
//   (a) the process dies in the hold, after the call's row is written and
//       before the commit: no row, no hold, nothing sent; the same message
//       asked again holds afresh and is answered once;
//   (b) two instances hold the same message on two connections: the second
//       waits on the budget's row while the first holds it, then finds the
//       first's call: one row, one hold, one request (also with the ids in
//       upper case);
//   (c) the admission fails at its last statement: nothing sent, the call
//       released, its hold freed; the same message again is told it ended;
//   (d) the admission's connection is lost at its last statement, before it
//       answers: the same message meanwhile is told it is on its way; then
//       nothing is sent, the call is released and the same message is told
//       it ended;
//   (e) after each ending (settled, released, held) the same message makes no
//       new call and sends nothing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConversationExchange } from '../../packages/core-commands/src/index.ts';
import { stepped } from '../api/conversation-epoch-fixture.ts';
import { folded } from '../api/openrouter-stand-in-fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { pricedWorld, type Asked, type PricedWorld } from './priced-chat-world.ts';
import { lockWaiter, repliesOf } from './paid-schedule-support.ts';

const serverUrl = databaseUrlFromEnvironment();

const upper = (asked: Asked): Asked => ({
  conversationId: asked.conversationId.toUpperCase(),
  messageId: asked.messageId.toUpperCase(),
});

// oxlint-disable-next-line max-lines-per-function -- one world, a schedule per statement a send can die at
describe.skipIf(serverUrl === undefined)('a paid hold or admission that dies', () => {
  let p: PricedWorld;
  let twin: ConversationExchange;

  beforeAll(async () => {
    p = await pricedWorld('priced_dies', undefined, 2);
    twin = await p.twin();
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  const twinAsks = async (asked: Asked) =>
    await twin(p.w.fixture.db.app, p.w.fixture.business, p.w.owner.presented, asked);

  it('(a) dies in the hold before its commit: nothing; asked again, answered once', async () => {
    const { business } = p.w.fixture;
    const asked = await p.question('What is due today?');
    const before = await p.committed();
    const sent = p.openrouter.received.length;
    const step = stepped(p.w.fixture.db.appUrl, 'insert into public.model_calls', 'hold-after');
    const answer = p.exchange(step.database, business, p.w.owner.presented, asked);
    answer.catch(() => null);
    await step.reached;
    await step.crash(p.w.fixture);
    // The hold's transaction is gone with its connection: the exchange fails, nothing after it runs.
    await expect(answer).rejects.toThrow(/CONNECTION/u);
    await step.close();
    expect(await p.calls(asked.conversationId)).toHaveLength(0);
    expect(await p.committed()).toBe(before);
    expect(p.openrouter.received.length).toBe(sent);
    expect(await twinAsks(asked)).toMatchObject({ answered: true });
    expect(p.openrouter.received.length).toBe(sent + 1);
    expect(await p.calls(asked.conversationId)).toMatchObject([{ state: 'settled' }]);
  });

  const twinCases: readonly (readonly [string, (asked: Asked) => Asked])[] = [
    ['the same ids', (asked) => asked],
    ['the ids in upper case', upper],
  ];
  it.each(twinCases)(
    '(b) two connections hold one message (%s): one row, one hold, one request',
    async (label, twinCase) => {
      const { business } = p.w.fixture;
      const asked = await p.question(`Who is away this week? (${label})`);
      const before = await p.committed();
      const sent = p.openrouter.received.length;
      const step = stepped(p.w.fixture.db.appUrl, 'insert into public.model_calls', 'hold-after');
      const first = p.exchange(step.database, business, p.w.owner.presented, asked);
      first.catch(() => null);
      await step.reached;
      const second = twinAsks(twinCase(asked));
      await lockWaiter(p, '%from public.budget_caps%');
      step.release();
      const [one, two] = await Promise.all([first, second]);
      await step.close();
      expect(one).toMatchObject({ answered: true });
      expect(two).not.toMatchObject({ code: 'RATE_LIMITED' });
      expect(two).not.toMatchObject({ code: 'BUDGET_UNAVAILABLE' });
      expect(p.openrouter.received.length).toBe(sent + 1);
      const calls = await p.calls(asked.conversationId);
      expect(calls).toHaveLength(1);
      expect(await p.committed()).toBe(before + Number(calls[0]?.['actual_minor']));
      expect(await repliesOf(p, asked.conversationId)).toHaveLength(1);
    },
  );

  it('(c) the admission fails at its last statement: nothing sent, released', async () => {
    const { business } = p.w.fixture;
    const asked = await p.question('What is overdue?');
    const before = await p.committed();
    const sent = p.openrouter.received.length;
    const step = stepped(p.w.fixture.db.appUrl, 'scope_record_id as page', 'fail-after');
    const answer = await p.exchange(step.database, business, p.w.owner.presented, asked);
    await step.close();
    expect(answer).toMatchObject({ answered: false, code: 'CUSTODY_NOT_ADMITTED' });
    expect(p.openrouter.received.length).toBe(sent);
    expect(await p.calls(asked.conversationId)).toMatchObject([{ state: 'released' }]);
    expect(await p.committed()).toBe(before);
    expect(await twinAsks(asked)).toMatchObject({ answered: false, code: 'ANSWER_ENDED' });
    expect(p.openrouter.received.length).toBe(sent);
  });

  it('(d) the connection is lost in the admission: nothing sent, released, then ended', async () => {
    const { business } = p.w.fixture;
    const asked = await p.question('What changed today?');
    const before = await p.committed();
    const sent = p.openrouter.received.length;
    const step = stepped(p.w.fixture.db.appUrl, 'scope_record_id as page', 'hold-after');
    const answer = p.exchange(step.database, business, p.w.owner.presented, asked);
    answer.catch(() => null);
    await step.reached;
    expect(await p.calls(asked.conversationId)).toMatchObject([{ state: 'dispatched' }]);
    expect(await twinAsks(asked)).toMatchObject({ answered: false, code: 'STILL_ANSWERING' });
    await step.crash(p.w.fixture);
    expect(await answer).toMatchObject({ answered: false, code: 'CUSTODY_NOT_ADMITTED' });
    await step.close();
    expect(p.openrouter.received.length).toBe(sent);
    expect(await p.calls(asked.conversationId)).toMatchObject([{ state: 'released' }]);
    expect(await p.committed()).toBe(before);
    expect(await twinAsks(asked)).toMatchObject({ answered: false, code: 'ANSWER_ENDED' });
    expect(p.openrouter.received.length).toBe(sent);
    expect(await repliesOf(p, asked.conversationId)).toHaveLength(0);
  });

  it('(e) after each ending, the same message makes no new call', async () => {
    const endings = [
      { answer: undefined, state: 'settled' },
      { answer: { status: 400, body: '{"error":"bad"}' }, state: 'released' },
      { answer: folded('openai/gpt-6.1', 'Someone else answered.'), state: 'liability_unknown' },
    ] as const;
    const usual = p.openrouter.answer;
    for (const ending of endings) {
      p.openrouter.answer = ending.answer === undefined ? usual : () => ending.answer;
      // oxlint-disable-next-line no-await-in-loop -- one ending at a time
      const asked = await p.question(`Ending ${ending.state}?`);
      // oxlint-disable-next-line no-await-in-loop -- one ending at a time
      const first = await p.ask(asked);
      // oxlint-disable-next-line no-await-in-loop -- one ending at a time
      expect(await p.calls(asked.conversationId)).toMatchObject([{ state: ending.state }]);
      p.openrouter.answer = usual;
      const sent = p.openrouter.received.length;
      for (const again of [asked, upper(asked)]) {
        // oxlint-disable-next-line no-await-in-loop -- each retry in turn
        const retried = await twinAsks(again);
        if (ending.state === 'settled') expect(retried).toMatchObject({ answered: true });
        else expect(retried).toMatchObject({ answered: false, code: 'ANSWER_ENDED' });
        // oxlint-disable-next-line no-await-in-loop -- each retry in turn
        expect(await p.calls(asked.conversationId)).toHaveLength(1);
      }
      expect(first).not.toBeNull();
      expect(p.openrouter.received.length).toBe(sent);
    }
  });
});
