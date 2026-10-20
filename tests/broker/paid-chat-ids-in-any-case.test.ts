// SPDX-License-Identifier: AGPL-3.0-only
//
// A uuid names one row whatever its case, so the paid path judges an id the
// same in upper case as in lower:
//
//   (a) a message once refused for its page (a client's task) stays refused
//       when it is asked again with its ids in upper case, after the client
//       is cleared: nothing reaches OpenRouter;
//   (b) a message asked with upper-case ids is answered once, its reply kept
//       against it, and the same message in lower case gets that reply with
//       no second request;
//   (c) the same message asked again in another case while its answer is out
//       makes no second call and no second request;
//   (d) the business named in upper case makes no second call;
//   (e) a person listed in upper case on the outside people setting is
//       offered and answered as one listed in lower case.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addClient, grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { listed, pricedWorld, type Asked, type PricedWorld } from './priced-chat-world.ts';
import { repliesOf } from './paid-schedule-support.ts';

const serverUrl = databaseUrlFromEnvironment();

const upper = (asked: Asked): Asked => ({
  conversationId: asked.conversationId.toUpperCase(),
  messageId: asked.messageId.toUpperCase(),
});

// oxlint-disable-next-line max-lines-per-function -- one world, a schedule per read that takes an id
describe.skipIf(serverUrl === undefined)('paid chat ids in any case', () => {
  let p: PricedWorld;

  beforeAll(async () => {
    p = await pricedWorld('priced_id_case');
    await p.w.fixture.db.app.withBusiness(p.w.fixture.business, async (tx) => {
      await grantTo(tx, p.w.owner, 'share');
    });
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('(a) refused for its page, then asked in upper case once the client is cleared: refused', async () => {
    const { db, business } = p.w.fixture;
    const made = await p.w.as(p.w.owner, 'task.create', { fields: { title: 'Roster for May' } });
    const taskId = String(made.body['recordId']);
    const asked = await p.question('What is left?', undefined, {
      scope: { kind: 'task', id: taskId },
    });
    const clientId = randomUUID();
    await addClient(db.app, business, clientId, p.w.owner);
    const placed = await p.w.as(p.w.owner, 'task.set_party', {
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: made.body['revision'],
      fields: { client: clientId },
    });
    expect(placed.status).toBe(200);
    expect(await p.ask(asked)).toMatchObject({ answered: false });
    const marks = await db.admin.execute(
      `select 1 from public.audit_events
        where command = 'model.call_refused' and attempted ->> 'messageId' = $1`,
      [asked.messageId],
    );
    expect(marks).toHaveLength(1);
    // The client is cleared: the message stays refused, in either case.
    await db.admin.execute(`update public.records set data = data - 'client' where id = $1`, [
      taskId,
    ]);
    const [cleared] = await db.admin.execute<{ readonly client: string | null }>(
      `select data ->> 'client' as client from public.records where id = $1`,
      [taskId],
    );
    expect(cleared).toStrictEqual({ client: null });
    expect(await p.ask(asked)).toMatchObject({ answered: false, code: 'CLIENT_MODEL_USE_OFF' });
    expect(p.openrouter.received).toHaveLength(0);
    await p.ask(upper(asked));
    expect(p.openrouter.received).toHaveLength(0);
    expect(await p.calls(asked.conversationId)).toHaveLength(0);
  });

  it('(b) asked in upper case: answered once, kept, and the lower case gets that reply', async () => {
    const asked = await p.question('What is due today?');
    const sent = p.openrouter.received.length;
    const kept = await p.ask(upper(asked));
    expect(kept).toMatchObject({ answered: true });
    expect(p.openrouter.received.length).toBe(sent + 1);
    expect(await repliesOf(p, asked.conversationId)).toMatchObject([{ answers: asked.messageId }]);
    expect(await p.ask(asked)).toMatchObject({
      answered: true,
      body: kept?.answered === true ? kept.body : '',
    });
    expect(await p.ask(upper(asked))).toMatchObject({ answered: true });
    expect(p.openrouter.received.length).toBe(sent + 1);
    expect(await p.calls(asked.conversationId)).toHaveLength(1);
  });

  it('(c) the same message in another case while its answer is out: one call, one request', async () => {
    const asked = await p.question('Who is away this week?');
    const sent = p.openrouter.received.length;
    p.openrouter.shut();
    const first = p.ask(asked);
    await p.openrouter.arrived(sent + 1);
    const second = await p.ask(upper(asked));
    expect(second).not.toMatchObject({ code: 'RATE_LIMITED' });
    p.openrouter.open();
    expect(await first).toMatchObject({ answered: true });
    expect(p.openrouter.received.length).toBe(sent + 1);
    expect(await p.calls(asked.conversationId)).toHaveLength(1);
    expect(await repliesOf(p, asked.conversationId)).toHaveLength(1);
  });

  it('(d) the business named in upper case, once in flight and once again: one call', async () => {
    const { db, business } = p.w.fixture;
    const asked = await p.question('What is overdue?');
    const before = await p.committed();
    const sent = p.openrouter.received.length;
    p.openrouter.shut();
    const first = p.ask(asked);
    await p.openrouter.arrived(sent + 1);
    const loud = business.toUpperCase();
    expect(await p.exchange(db.app, loud, p.w.owner.presented, asked)).not.toMatchObject({
      code: 'RATE_LIMITED',
    });
    p.openrouter.open();
    expect(await first).toMatchObject({ answered: true });
    expect(await p.exchange(db.app, loud, p.w.owner.presented, asked)).toMatchObject({
      answered: true,
    });
    expect(p.openrouter.received.length).toBe(sent + 1);
    const calls = await p.calls(asked.conversationId);
    expect(calls).toHaveLength(1);
    expect(await p.committed()).toBe(before + Number(calls[0]?.['actual_minor']));
  });
});

describe.skipIf(serverUrl === undefined)('a person listed in upper case', () => {
  let p: PricedWorld;

  beforeAll(async () => {
    p = await pricedWorld('priced_listed_upper', (business, owner) => [
      listed(business, owner).toUpperCase(),
    ]);
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('(e) is offered the paid model and answered once', async () => {
    const asked = await p.question('What is due today?');
    expect(await p.ask(asked)).toMatchObject({ answered: true });
    expect(p.openrouter.received).toHaveLength(1);
    expect(await p.calls(asked.conversationId)).toMatchObject([{ state: 'settled' }]);
  });
});
