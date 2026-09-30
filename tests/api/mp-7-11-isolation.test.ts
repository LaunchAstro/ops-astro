// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11 isolation for the tab row's operations (conversation.list,
// conversation.rename, conversation.set_scope), through the real boundary
// and a fresh Postgres. The crossings, each with its status checked and no
// body carrying the conversation's title, page, id or canary, refusals
// included: another business (the same login in Bravo, answered as a made-up
// id is, and audited); another client in the same business (a read-any grant
// on client two's task lists, renames and scopes nothing of a conversation
// scoped to client one's); another person under a live delegation (the
// owner's own agent reaches none of the three).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, shareWithClient, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { authorised, post, tokenFor, type Answer } from './fixture.ts';
import { checksWorld, pickedUpOn, type PickedUp } from './mp-6-1-checks-fixture.ts';
import type { Controls } from './controls-fixture.ts';
import {
  CONVERSATION,
  conversationWorld,
  started,
  type ConversationWorld,
} from './aw-03-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const OPERATIONS = ['conversation.list', 'conversation.rename', 'conversation.set_scope'] as const;

const bodyFor = (name: (typeof OPERATIONS)[number], id: string): Record<string, unknown> =>
  name === 'conversation.list'
    ? {}
    : name === 'conversation.rename'
      ? { conversationId: id, title: 'Taken over' }
      : { conversationId: id, page: { address: '/elsewhere', shows: 'Elsewhere' } };

// eslint-disable-next-line max-lines-per-function -- one world of two businesses, every crossing on it
describe.skipIf(serverUrl === undefined)('MP-7-11 isolation', () => {
  let c: Controls;
  let w: ConversationWorld;
  let work: PickedUp;
  const canary = `CANARY-${randomUUID()}`;
  const title = `Title-${randomUUID()}`;
  const page = { address: `/tasks/${randomUUID()}`, shows: `Shows-${randomUUID()}` };
  let conversationId = '';
  let taskOne = '';
  let taskTwo = '';
  let readerOfTwo: Member;
  let both: Member;

  const foreign = (): readonly string[] => [
    canary,
    title,
    page.address,
    page.shows,
    conversationId,
  ];
  const carriesNothing = (answer: Answer | { body: unknown }): void => {
    const text = JSON.stringify(answer.body);
    for (const value of foreign()) expect(text).not.toContain(value);
  };
  const unchanged = async (): Promise<void> => {
    const rows = await w.fixture.db.admin.execute<{ title: string; page_address: string }>(
      `select title, page_address from public.conversations where id = $1`,
      [conversationId],
    );
    expect(rows[0]).toEqual({ title, page_address: page.address });
  };

  beforeAll(async () => {
    ({ c } = await checksWorld('mp_7_11_isolation'));
    w = await conversationWorld(c);
    work = await pickedUpOn(c, 'conversation_tabs_crossing');
    taskOne = (await c.createTask('client one')).id;
    taskTwo = (await c.createTask('client two')).id;
    conversationId = await started(w, w.owner, {
      scope: { kind: 'task', id: taskOne },
      title,
      body: `${canary} what did the supplier quote?`,
    });
    await w.as(w.owner, 'conversation.set_scope', { conversationId, page });
    const { db, business } = w.fixture;
    readerOfTwo = await enrol(db.app, business, 'reader-two');
    both = await enrol(db.app, business, 'both');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, readerOfTwo, 'read', { kind: 'record', id: taskTwo }, false, CONVERSATION);
      await grantTo(tx, readerOfTwo, 'write', undefined, false, CONVERSATION);
      await grantTo(tx, w.owner, 'share');
    });
    const bravo = await insertBusiness(db.app, 'bravo');
    await installSpine(db.app, bravo);
    await db.app.withBusiness(bravo, async (tx) => {
      const { insertActor, insertLogin, insertMapping, insertMembership, insertPerson } =
        await import('../identity/fixture.ts');
      const personId = await insertPerson(tx, 'both-bravo');
      const actorId = await insertActor(tx, personId);
      await insertMembership(tx, personId);
      const loginId = await insertLogin(tx, both.presented.subject);
      await insertMapping(tx, loginId, personId, actorId);
      const member = { personId, actorId, presented: both.presented };
      await grantTo(tx, member, 'write', undefined, false, CONVERSATION);
      await grantTo(tx, member, 'read', undefined, false, CONVERSATION);
    });
  }, 180_000);

  afterAll(async () => await c?.drop());

  it('MP-7-11 isolation: the owner lists their conversation with its page', async () => {
    const own = await w.as(w.owner, 'conversation.list', {});
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).toContain(conversationId);
  });

  it('MP-7-11 isolation: another business renames and scopes nothing, answered exactly as a made-up id, and audited', async () => {
    const token = authorised(await tokenFor(both.presented.subject));
    for (const name of ['conversation.rename', 'conversation.set_scope'] as const) {
      const path = `/api/b/bravo/conversation/${name.split('.')[1] ?? ''}`;
      // eslint-disable-next-line no-await-in-loop -- one crossing at a time
      const across = await post(
        w.api,
        path,
        { operationId: randomUUID(), ...bodyFor(name, conversationId) },
        token,
      );
      // eslint-disable-next-line no-await-in-loop
      const madeUp = await post(
        w.api,
        path,
        { operationId: randomUUID(), ...bodyFor(name, randomUUID()) },
        token,
      );
      expect(across.status).toBe(404);
      expect(across).toEqual(madeUp);
      carriesNothing(across);
    }
    const list = await post(w.api, '/api/b/bravo/conversation/list', {}, token);
    expect(list.status).toBe(200);
    carriesNothing(list);
    const audited = await w.count(
      `select count(*) as n from public.audit_events a join public.businesses b on b.id = a.business_id
        where b.key = 'bravo' and a.command in ('conversation.rename', 'conversation.set_scope')
          and a.outcome = 'refused'`,
      [],
    );
    expect(audited).toBe(4);
    await unchanged();
  });

  it('MP-7-11 isolation: another client in the same business: a read-any grant on client two lists, renames and scopes nothing of client one’s', async () => {
    for (const name of OPERATIONS) {
      // eslint-disable-next-line no-await-in-loop -- one crossing at a time
      const answer = await w.as(readerOfTwo, name, bodyFor(name, conversationId));
      if (name === 'conversation.list') expect(answer.status).toBe(200);
      else expect(answer.status).toBe(403);
      carriesNothing(answer);
    }
    await unchanged();
  });

  it('MP-7-11 isolation: another person under a live delegation: the owner’s agent reaches none of the three', async () => {
    for (const name of OPERATIONS) {
      // eslint-disable-next-line no-await-in-loop -- one lease, one call at a time
      const agent = await c.asAgent(name, bodyFor(name, conversationId), work.credential);
      expect(agent.status).toBe(403);
      expect(agent.body['code']).toBe('DELEGATION_EXCLUDES_OPERATION');
      carriesNothing(agent);
    }
    await unchanged();
  });

  it('MP-7-11 isolation: a client shared on the scoped task lists, renames and scopes nothing', async () => {
    const client = await shareWithClient(w.fixture.db.app, w.fixture.business, w.owner, taskOne);
    for (const name of OPERATIONS) {
      // eslint-disable-next-line no-await-in-loop -- one crossing at a time
      const answer = await w.as(client, name, bodyFor(name, conversationId));
      expect([403, 404]).toContain(answer.status);
      carriesNothing(answer);
    }
    await unchanged();
  });

  it('MP-7-11 canary: the planted title, page and message never reach the audit payload, the register or an error', async () => {
    const rows = await w.fixture.db.admin.execute<{ readonly row: string }>(
      `select row_to_json(a)::text as row from public.audit_events a
       union all select row_to_json(r)::text from public.operations r`,
      [],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows)
      for (const value of [canary, title, page.shows]) expect(row.row).not.toContain(value);
    const bad = await w.as(w.owner, 'conversation.rename', { conversationId, title: 7, canary });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    carriesNothing(bad);
  });

  it('MP-7-11 revoked: with every grant revoked, the owner lists, renames and scopes nothing', async () => {
    await w.fixture.db.admin.execute(
      `update public.grants set revoked_at = now() where subject_id = $1 and revoked_at is null`,
      [w.owner.personId],
    );
    for (const name of OPERATIONS) {
      // eslint-disable-next-line no-await-in-loop -- one call at a time
      const answer = await w.as(w.owner, name, bodyFor(name, conversationId));
      expect(answer.status).toBe(403);
      carriesNothing(answer);
    }
    await unchanged();
  });
});
