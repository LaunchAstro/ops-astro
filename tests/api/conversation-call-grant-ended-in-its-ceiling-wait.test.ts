// SPDX-License-Identifier: AGPL-3.0-only
//
// The exchange's call is judged again (`stillHeld`) in the transaction that
// writes its row, and that transaction then waits on the operation's ceiling
// lock. The ceiling lock is held on a connection of its own, the call is seen
// waiting on it, and the person's conversation grant ends while it waits:
// revoked on a third connection, or lapsed on the database clock. A call whose
// row commits after its grant ended must reach no provider.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONVERSATION_ANSWER } from '../../packages/core-connectors/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, waiterOf, waitPast, type Held } from '../support/lock-wait-race.ts';
import {
  CONVERSATION,
  conversationWorld,
  expiringSoon,
  started,
  type ConversationWorld,
} from './aw-03-fixture.ts';
import { composedWith, localModel, type LocalModel } from './aw-03-exchange-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, the held ceiling and both endings on it
describe.skipIf(serverUrl === undefined)("a call's grant ended in its ceiling wait", () => {
  let w: ConversationWorld;
  let model: LocalModel;
  /** Set by a case: the next call's ceiling lock is taken on a connection of its own first. */
  let onCeiling: ((held: Held) => void) | undefined;

  beforeAll(async () => {
    const base = await conversationWorld('exchange_ceiling_wait');
    const key = `limit:${base.fixture.business}:model_call:${CONVERSATION_ANSWER.key}`;
    // Runs as the broker asks custody for the account, before the row's transaction.
    model = await localModel(undefined, async () => {
      const report = onCeiling;
      if (report === undefined) return;
      onCeiling = undefined;
      report(
        await hold(base.fixture.db, async (execute) => {
          await execute('select pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
        }),
      );
    });
    w = await conversationWorld({
      fixture: base.fixture,
      api: composedWith(base.fixture, model.exchange),
    });
  }, 180_000);

  afterAll(async () => {
    await model?.close();
    await w?.drop();
  });

  /** A person holding `conversation:write` and `read` alone, as the world's colleague does. */
  async function writer(name: string): Promise<Member> {
    const member = await enrol(w.fixture.db.app, w.fixture.business, name);
    await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      await grantTo(tx, member, 'write', undefined, false, CONVERSATION);
      await grantTo(tx, member, 'read');
    });
    return member;
  }

  const tally = async (conversationId: string) => ({
    sent: model.provider.seen.length,
    calls: await w.count(
      'select count(*) as n from public.model_calls where conversation_id = $1',
      [conversationId],
    ),
    replies: await w.count(
      `select count(*) as n from public.conversation_messages
        where conversation_id = $1 and role = 'agent'`,
      [conversationId],
    ),
  });

  /** `member` asks again; once its call is seen parked on the ceiling, `whileParked` runs, then the lock goes. */
  async function askWhileCeilingHeld(
    member: Member,
    conversationId: string,
    whileParked: () => Promise<void>,
  ): Promise<void> {
    const taken = new Promise<Held>((resolve) => {
      onCeiling = resolve;
    });
    const answer = w.as(member, 'conversation.message', {
      conversationId,
      body: 'Asked while the ceiling is held',
    });
    const held = await taken;
    try {
      await waiterOf(w.fixture.db, held);
      await whileParked();
    } finally {
      await held.letGo();
    }
    await answer;
  }

  it('sends nothing when the grant is revoked while the call waits on its ceiling', async () => {
    const member = await writer('revoked-in-wait');
    const conversationId = await started(w, member, { body: 'First question' });
    const before = await tally(conversationId);
    await askWhileCeilingHeld(member, conversationId, async () => {
      await w.fixture.db.admin.execute(
        `update public.grants set revoked_at = clock_timestamp()
          where subject_id = $1 and collection = $2 and action = 'write' and revoked_at is null`,
        [member.personId, CONVERSATION],
      );
    });
    expect(await tally(conversationId)).toEqual(before);
  });

  it('sends nothing when the grant lapses while the call waits on its ceiling', async () => {
    const member = await writer('lapsed-in-wait');
    const conversationId = await started(w, member, { body: 'First question' });
    const before = await tally(conversationId);
    const { expiry } = await expiringSoon(w, member.personId, CONVERSATION, 'write');
    await askWhileCeilingHeld(member, conversationId, async () => {
      await waitPast(w.fixture.db, expiry);
    });
    expect(await tally(conversationId)).toEqual(before);
  });
});
