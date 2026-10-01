// SPDX-License-Identifier: AGPL-3.0-only
//
// C36 address refusals (TR-S-B3-7): a conversation's address keeps AW-03's
// refusals, read through the real boundary and a fresh Postgres by the id the
// address carries (the web's registry resolves it to the screen that reads by
// the same id: c36-conversation-address in tests/surfaces). Another business
// gets NOT_FOUND, indistinguishable from a made-up address; a colleague
// without the read-any grant gets SCOPE_NOT_GRANTED and nothing else; a client
// session is refused; after the purge the address returns only the wrap-up.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeConversation, writeWrapUp } from '../../packages/core-commands/src/index.ts';
import { writeBusinessSetting } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { shareWithClient } from '../commands/fixture.ts';
import { CODE_REVISION } from './aw-03-fixture.ts';
import { addressWorld, carriesNothing, conversationOf, type AddressWorld } from './c36-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, each refusal on it
describe.skipIf(serverUrl === undefined)('C36 address refusals', () => {
  let x: AddressWorld;

  beforeAll(async () => {
    x = await addressWorld('c36_address');
  }, 180_000);

  afterAll(async () => await x?.c.drop());

  it('C36 address refusals: another business gets NOT_FOUND, byte for byte a made-up address', async () => {
    const across = await x.inBravo(x.address);
    const madeUp = await x.inBravo(`/agent/${randomUUID()}`);
    expect(across.status).toBe(404);
    expect(across.body['code']).toBe('NOT_FOUND');
    expect(JSON.stringify(across.body)).toBe(JSON.stringify(madeUp.body));
    expect(carriesNothing(x, across)).toBe(true);
  });

  it('C36 address refusals: a colleague without the read-any grant gets SCOPE_NOT_GRANTED and nothing else', async () => {
    const colleague = await x.w.as(x.w.colleague, 'conversation.read', {
      conversationId: conversationOf(x.address),
    });
    expect(colleague.status).toBe(403);
    expect(colleague.body['code']).toBe('SCOPE_NOT_GRANTED');
    expect(colleague.body).not.toHaveProperty('conversation');
    expect(colleague.body).not.toHaveProperty('messages');
    expect(carriesNothing(x, colleague)).toBe(true);
  });

  it('C36 address refusals: a client session is refused', async () => {
    const { db, business } = x.w.fixture;
    const client = await shareWithClient(db.app, business, x.w.owner, x.taskOne);
    const answer = await x.w.as(client, 'conversation.read', {
      conversationId: conversationOf(x.address),
    });
    expect([403, 404]).toContain(answer.status);
    expect(carriesNothing(x, answer)).toBe(true);
  });

  it('C36 address refusals: after the purge the address returns only the wrap-up', async () => {
    const { db, business } = x.w.fixture;
    const conversationId = conversationOf(x.address);
    await db.app.withBusiness(business, async (tx) => {
      await writeBusinessSetting(tx, { key: 'conversation_window_days', value: 7 });
    });
    // The scoped task is still open, so it is completed first: open work holds the body.
    const task = await x.w.as(x.w.owner, 'task.read', { recordId: x.taskOne });
    const revision = (task.body['task'] as { revision: number }).revision;
    const done = await x.w.as(x.w.owner, 'task.complete', {
      operationId: randomUUID(),
      recordId: x.taskOne,
      expectedRevision: revision,
    });
    expect(done.status).toBe(200);
    await db.admin.execute(
      `update public.records
          set data = jsonb_set(data, '{completed_at}', to_jsonb((now() - interval '8 days')::text))
        where id = $1`,
      [x.taskOne],
    );
    await x.w.age(conversationId, 8);
    const wrapped = await db.app.withBusiness(
      business,
      async (tx) => await writeWrapUp(tx, { conversationId, codeRevision: CODE_REVISION }),
    );
    expect(wrapped).toMatchObject({ ok: true, written: true });
    const purged = await db.app.withBusiness(
      business,
      async (tx) => await purgeConversation(tx, { conversationId, operationId: randomUUID() }),
    );
    expect(purged).toMatchObject({ ok: true, replayed: false });
    const after = await x.w.as(x.w.owner, 'conversation.read', { conversationId });
    expect(after.status).toBe(200);
    expect(after.body['messages']).toBeNull();
    expect(after.body['wrapUp']).not.toBeNull();
    expect(JSON.stringify(after.body)).not.toContain('And the terms?');
  });
});
