// SPDX-License-Identifier: AGPL-3.0-only
//
// A paid call settles only with its reply kept, in one transaction:
//
//   (a) the reply's insert fails: nothing settles and nothing is kept; the
//       sweep holds the call, the same message is told its answer ended, and
//       the message sent again holds afresh and is answered;
//   (b) the process dies between the settlement and its commit: the same;
//   (c) the same message from another instance during the settlement is told
//       its answer is on its way, then gets the kept reply;
//   (d) no settled paid call is ever without its reply.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConversationExchange } from '../../packages/core-commands/src/index.ts';
import { stepped } from '../api/conversation-epoch-fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { pricedWorld, type Asked, type PricedWorld } from './priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

// oxlint-disable-next-line max-lines-per-function -- one world, a schedule per way the settle can fail
describe.skipIf(serverUrl === undefined)('a settled paid call always has its reply', () => {
  let p: PricedWorld;
  let twin: ConversationExchange;

  beforeAll(async () => {
    p = await pricedWorld('priced_settle_keeps');
    twin = await p.twin();
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  const replies = async (conversationId: string): Promise<number> =>
    await p.w.count(
      `select count(*)::text as n from public.conversation_messages
        where conversation_id = $1 and role = 'agent'`,
      [conversationId],
    );

  async function endedThenAskedAgain(asked: Asked): Promise<void> {
    expect(await p.calls(asked.conversationId)).toMatchObject([{ state: 'dispatched' }]);
    expect(await replies(asked.conversationId)).toBe(0);
    await p.sweep(asked.conversationId);
    expect(await p.calls(asked.conversationId)).toMatchObject([{ state: 'liability_unknown' }]);
    const sent = p.openrouter.received.length;
    expect(await p.ask(asked)).toMatchObject({ answered: false, code: 'ANSWER_ENDED' });
    expect(p.openrouter.received.length).toBe(sent);
    const again = await p.next(asked.conversationId, 'What is due today? (again)');
    expect(await p.ask(again)).toMatchObject({ answered: true });
  }

  /** A paid ask on a connection of its own, stopped just after its settlement, before the commit. */
  async function heldAtTheSettle(asked: Asked) {
    const { db, business } = p.w.fixture;
    const step = stepped(db.appUrl, "set state = 'settled'", 'hold-after');
    const answer = p.exchange(step.database, business, p.w.owner.presented, asked);
    // A crash rejects it while the case still waits on the crash: handled from the start.
    answer.catch(() => undefined);
    await step.reached;
    return { step, answer };
  }

  it('(a) the reply cannot be inserted: nothing settles; ended, then asked again', async () => {
    const asked = await p.question('What is due today?');
    const { db } = p.w.fixture;
    await db.admin.execute(`
      create function public.case_no_reply() returns trigger language plpgsql as $$
      begin
        if new.role = 'agent' and new.conversation_id = '${asked.conversationId}' then
          raise exception 'the reply is refused';
        end if;
        return new;
      end $$;
      create trigger case_no_reply before insert on public.conversation_messages
        for each row execute function public.case_no_reply();`);
    await expect(p.ask(asked)).rejects.toThrow(/the reply is refused/u);
    await db.admin.execute(`drop trigger case_no_reply on public.conversation_messages`);
    await endedThenAskedAgain(asked);
  });

  it('(b) the process dies between the settlement and its commit: the same', async () => {
    const asked = await p.question('What is overdue?');
    const { step, answer } = await heldAtTheSettle(asked);
    // The serving process dies with its connection; the held caller never goes on.
    await step.crash(p.w.fixture);
    await expect(answer).rejects.toThrow(/CONNECTION_CLOSED/u);
    await step.close();
    await endedThenAskedAgain(asked);
  });

  it('(c) the same message during the settlement: answering, then the kept reply', async () => {
    const { db, business } = p.w.fixture;
    const asked = await p.question('Who is away this week?');
    const { step, answer } = await heldAtTheSettle(asked);
    expect(await twin(db.app, business, p.w.owner.presented, asked)).toMatchObject({
      answered: false,
      code: 'STILL_ANSWERING',
    });
    step.release();
    const kept = await answer;
    expect(kept).toMatchObject({ answered: true });
    await step.close();
    expect(await twin(db.app, business, p.w.owner.presented, asked)).toMatchObject({
      answered: true,
      body: kept?.answered === true ? kept.body : '',
    });
  });

  it('(d) no settled paid call is without its reply', async () => {
    const orphans = await p.w.count(
      `select count(*)::text as n from public.model_calls m
        where m.business_id = $1 and m.planning_envelope_id is not null and m.state = 'settled'
          and not exists (select 1 from public.conversation_messages r
                           where r.business_id = m.business_id
                             and r.answers_message_id = m.conversation_message_id)`,
      [p.w.fixture.business],
    );
    expect(orphans).toBe(0);
    expect(
      await p.w.count(
        `select count(*)::text as n from public.model_calls
          where business_id = $1 and planning_envelope_id is not null and state = 'settled'`,
        [p.w.fixture.business],
      ),
    ).toBeGreaterThan(0);
  });
});
