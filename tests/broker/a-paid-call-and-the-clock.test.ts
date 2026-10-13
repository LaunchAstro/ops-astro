// SPDX-License-Identifier: AGPL-3.0-only
//
// A paid call against the clock:
//
//   (a) the same message from another instance, whose read found no reply and
//       which reached the hold only after the first call settled with its
//       reply and some time passed: it gets that kept reply, never "ended,
//       send it again", which would charge the same words twice;
//   (b) swept between its hold and its send: nothing is sent, the call is
//       released and its hold freed;
//   (c) answered after the sweep held it: the late answer settles at its
//       price and its reply is kept, and committed is that price alone.
//
// Time is moved on the rows, as the sweep's own cases move it, never slept.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConversationExchange } from '../../packages/core-commands/src/index.ts';
import { stepped } from '../api/conversation-epoch-fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { pricedWorld, type PricedWorld } from './priced-chat-world.ts';
import { repliesOf, steppedCustody } from './paid-schedule-support.ts';

const serverUrl = databaseUrlFromEnvironment();

// oxlint-disable-next-line max-lines-per-function -- one world, a schedule per clock edge
describe.skipIf(serverUrl === undefined)('a paid call and the clock', () => {
  let p: PricedWorld;
  let twin: ConversationExchange;

  beforeAll(async () => {
    p = await pricedWorld('priced_clock', undefined, 2);
    twin = await p.twin();
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('(a) a twin that reaches the hold well after the reply was kept gets that reply', async () => {
    const { db, business } = p.w.fixture;
    const asked = await p.question('What is due today?');
    const arriving = p.openrouter.received.length + 1;
    p.openrouter.shut();
    const first = p.ask(asked);
    await p.openrouter.arrived(arriving);
    // The twin read no reply and is stopped just before its hold.
    const step = stepped(db.appUrl, 'from public.budget_caps', 'hold-before');
    const second = twin(step.database, business, p.w.owner.presented, asked);
    second.catch(() => null);
    await step.reached;
    p.openrouter.open();
    const kept = await first;
    expect(kept).toMatchObject({ answered: true });
    const sent = p.openrouter.received.length;
    // A minute passes before the twin goes on.
    await db.admin.execute(
      `update public.model_calls set ended_at = ended_at - interval '1 minute',
              completed_at = completed_at - interval '1 minute',
              accepted_at = accepted_at - interval '1 minute',
              started_at = started_at - interval '1 minute'
        where conversation_message_id = $1`,
      [asked.messageId],
    );
    step.release();
    const answer = await second;
    await step.close();
    expect(p.openrouter.received.length).toBe(sent);
    expect(await p.calls(asked.conversationId)).toHaveLength(1);
    // Told the answer ended, the person sends the same words again: a second charge.
    expect(answer !== null && 'code' in answer ? answer.code : null).not.toBe('ANSWER_ENDED');
    expect(answer).toMatchObject({
      answered: true,
      body: kept?.answered === true ? kept.body : '',
    });
  });

  it('(b) swept between the hold and the send: nothing sent, released, the hold freed', async () => {
    const { db, business } = p.w.fixture;
    const asked = await p.question('Who is away this week?');
    const before = await p.committed();
    const sent = p.openrouter.received.length;
    const exchange = await p.twin(
      steppedCustody(async () => {
        await p.sweep(asked.conversationId);
      }),
    );
    expect(await exchange(db.app, business, p.w.owner.presented, asked)).toMatchObject({
      answered: false,
    });
    expect(p.openrouter.received.length).toBe(sent);
    expect(await p.calls(asked.conversationId)).toMatchObject([{ state: 'released' }]);
    expect(await p.committed()).toBe(before);
    expect(await repliesOf(p, asked.conversationId)).toHaveLength(0);
  });

  it('(c) answered after the sweep: settled at its price, the reply kept', async () => {
    const asked = await p.question('What is overdue?');
    const before = await p.committed();
    const arriving = p.openrouter.received.length + 1;
    p.openrouter.shut();
    const answer = p.ask(asked);
    await p.openrouter.arrived(arriving);
    await p.sweep(asked.conversationId);
    expect(await p.calls(asked.conversationId)).toMatchObject([{ state: 'liability_unknown' }]);
    p.openrouter.open();
    expect(await answer).toMatchObject({ answered: true });
    const [call] = await p.calls(asked.conversationId);
    expect(call).toMatchObject({ state: 'settled' });
    expect(await repliesOf(p, asked.conversationId)).toHaveLength(1);
    expect(await p.committed()).toBe(before + Number(call?.['actual_minor']));
  });
});
