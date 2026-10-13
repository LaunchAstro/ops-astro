// SPDX-License-Identifier: AGPL-3.0-only
//
// One paid message, one call and one charge, whichever API instance asks.
// While the first instance's call is with OpenRouter, the second is told the
// answer is on its way: no row, no hold, no request. A twin whose lookup found
// nothing but whose insert meets the message's call (the unique index) holds
// nothing and sends nothing either. Once the reply is kept, the second
// instance answers with it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConversationExchange } from '../../packages/core-commands/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold } from '../support/lock-wait-race.ts';
import { PAID_KEY, pricedWorld, type PricedWorld } from './priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

// oxlint-disable-next-line max-lines-per-function -- two instances, one schedule per way a twin meets the call
describe.skipIf(serverUrl === undefined)('one paid message across two instances', () => {
  let p: PricedWorld;
  let twin: ConversationExchange;

  beforeAll(async () => {
    p = await pricedWorld('priced_one_charge', undefined, 2);
    twin = await p.twin();
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  const twinAsks = async (asked: { conversationId: string; messageId: string }) =>
    await twin(p.w.fixture.db.app, p.w.fixture.business, p.w.owner.presented, asked);

  it('the second instance is told it is answering, then gets the kept reply', async () => {
    const asked = await p.question('What is due today?');
    const before = await p.committed();
    p.openrouter.shut();
    const first = p.ask(asked);
    await p.openrouter.arrived(1);
    expect(await twinAsks(asked)).toMatchObject({ answered: false, code: 'STILL_ANSWERING' });
    expect(await p.calls(asked.conversationId)).toHaveLength(1);
    expect(p.openrouter.received).toHaveLength(1);
    p.openrouter.open();
    const kept = await first;
    expect(kept).toMatchObject({ answered: true });
    expect(await twinAsks(asked)).toStrictEqual({ ...kept, cites: [] });
    expect(p.openrouter.received).toHaveLength(1);
    const [call] = await p.calls(asked.conversationId);
    expect(await p.committed()).toBe(before + Number(call?.['actual_minor']));
  });

  it("an insert that meets the message's call holds nothing and sends nothing", async () => {
    const { db, business } = p.w.fixture;
    const template = await p.question('A first question, for a row to copy.');
    await p.ask(template);
    const asked = await p.question('What is overdue?');
    const sent = p.openrouter.received.length;
    const limit = `limit:${business}:model_call:${PAID_KEY}`;
    const holder = await hold(db, async (execute) => {
      await execute('select pg_advisory_xact_lock(hashtextextended($1, 0))', [limit]);
    });
    const answer = p.ask(asked);
    for (let tries = 0; tries < 500; tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- polls the server
      const waiting = await p.w.count(
        `select count(*)::text as n from pg_stat_activity
          where datname = current_database() and $1::int = any(pg_blocking_pids(pid))`,
        [holder.pid],
      );
      if (waiting > 0) break;
      // oxlint-disable-next-line no-await-in-loop -- polls the server
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    // Another writer names the message after this send's lookup: an ended call of its own.
    await db.admin.execute(
      `insert into public.model_calls
         (business_id, id, conversation_id, conversation_message_id, planning_envelope_id,
          operation_key, state, reserved_minor, route_key, route_reach, credential_kind, provider, credential_ref,
          account, started_at, ended_at)
       select business_id, gen_random_uuid(), conversation_id, $2, planning_envelope_id,
              operation_key, 'released', reserved_minor,
              route_key, route_reach, credential_kind, provider, credential_ref, account,
              clock_timestamp(), clock_timestamp()
         from public.model_calls where conversation_id = $1`,
      [template.conversationId, asked.messageId],
    );
    await holder.letGo();
    expect(await answer).toMatchObject({ answered: false, code: 'ANSWER_ENDED' });
    const rows = await db.admin.execute<{ readonly state: string }>(
      `select state from public.model_calls where conversation_message_id = $1`,
      [asked.messageId],
    );
    expect(rows.map((row) => row.state)).toStrictEqual(['released']);
    expect(p.openrouter.received.length).toBe(sent);
  });
});
