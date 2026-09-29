// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-03 isolation, client, revoked and canary, through the real boundary and
// a fresh Postgres.
//
// A conversation is its owner's alone (the permission table: `conversation:
// write` for the owner's own, `conversation:read` the read-any grant nobody
// holds on install). The crossings: another business (the same login in
// Bravo, answered exactly as a made-up id is, and audited); another client in
// the same business (a read-any grant on client two's task does not reach a
// conversation scoped to client one's); another person under a live
// delegation (the owner's own agent, working under the owner's delegation,
// reaches nothing of the owner's conversation). Each checks the status and
// that no body carries the conversation's title, subject, owner name, id or
// the canary in its first message, refusals included.

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

// eslint-disable-next-line max-lines-per-function -- one world of two businesses, every crossing on it
describe.skipIf(serverUrl === undefined)('AW-03 isolation', () => {
  let c: Controls;
  let w: ConversationWorld;
  let work: PickedUp;
  const canary = `CANARY-${randomUUID()}`;
  const title = `Title-${randomUUID()}`;
  const subject = `Subject-${randomUUID()}`;
  let conversationId = '';
  let taskOne = '';
  let taskTwo = '';
  let readerOfTwo: Member;
  let readerOfOne: Member;
  let both: Member;

  const foreign = (): readonly string[] => [canary, title, subject, conversationId, 'decider'];
  const carriesNothing = (answer: Answer | { body: unknown }): void => {
    const text = JSON.stringify(answer.body);
    for (const value of foreign()) expect(text).not.toContain(value);
  };
  const readAs = async (member: Member, id = conversationId): Promise<Answer> =>
    await w.as(member, 'conversation.read', { conversationId: id });

  beforeAll(async () => {
    ({ c } = await checksWorld('aw_03_isolation'));
    w = await conversationWorld(c);
    work = await pickedUpOn(c, 'conversation_crossing');
    taskOne = (await c.createTask('client one')).id;
    taskTwo = (await c.createTask('client two')).id;
    conversationId = await started(w, w.owner, {
      scope: { kind: 'task', id: taskOne },
      title,
      subject,
      body: `${canary} what did the supplier quote?`,
    });
    const { db, business } = w.fixture;
    readerOfOne = await enrol(db.app, business, 'reader-one');
    readerOfTwo = await enrol(db.app, business, 'reader-two');
    both = await enrol(db.app, business, 'both');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, readerOfOne, 'read', { kind: 'record', id: taskOne }, false, CONVERSATION);
      await grantTo(tx, readerOfTwo, 'read', { kind: 'record', id: taskTwo }, false, CONVERSATION);
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
      await grantTo(
        tx,
        { personId, actorId, presented: both.presented },
        'write',
        undefined,
        false,
        CONVERSATION,
      );
      await grantTo(
        tx,
        { personId, actorId, presented: both.presented },
        'read',
        undefined,
        false,
        CONVERSATION,
      );
    });
  }, 180_000);

  afterAll(async () => await c?.drop());

  it('AW-03 isolation: the owner reads their own conversation', async () => {
    const own = await readAs(w.owner);
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).toContain(canary);
  });

  it('AW-03 isolation: another business answers NOT_FOUND, exactly as a made-up id, and audited', async () => {
    const path = '/api/b/bravo/conversation/read';
    const token = authorised(await tokenFor(both.presented.subject));
    const across = await post(w.api, path, { conversationId }, token);
    const madeUp = await post(w.api, path, { conversationId: randomUUID() }, token);
    expect(across.status).toBe(404);
    expect(across).toEqual(madeUp);
    carriesNothing(across);
    const audited = await w.count(
      `select count(*) as n from public.audit_events a join public.businesses b on b.id = a.business_id
        where b.key = 'bravo' and a.command = 'conversation.read' and a.outcome = 'refused'`,
      [],
    );
    expect(audited).toBe(2);
  });

  it('AW-03 isolation: a colleague without the read-any grant gets SCOPE_NOT_GRANTED and nothing else', async () => {
    const colleague = await readAs(w.colleague);
    expect(colleague.status).toBe(403);
    expect(colleague.body['code']).toBe('SCOPE_NOT_GRANTED');
    carriesNothing(colleague);
    const write = await w.as(w.colleague, 'conversation.message', {
      conversationId,
      body: 'mine now',
    });
    expect(write.status).toBe(403);
    carriesNothing(write);
  });

  it('AW-03 isolation: another client in the same business: a read-any grant on client two does not reach client one', async () => {
    const wrongClient = await readAs(readerOfTwo);
    expect(wrongClient.status).toBe(403);
    expect(wrongClient.body['code']).toBe('SCOPE_NOT_GRANTED');
    carriesNothing(wrongClient);
    const rightClient = await readAs(readerOfOne);
    expect(rightClient.status).toBe(200);
    expect(JSON.stringify(rightClient.body)).toContain(title);
  });

  it('AW-03 isolation: another person under a live delegation: the owner’s agent reaches nothing of the conversation', async () => {
    for (const name of ['conversation.read', 'conversation.message']) {
      // eslint-disable-next-line no-await-in-loop -- one lease, one call at a time
      const agent = await c.asAgent(
        name,
        { conversationId, body: 'from the agent' },
        work.credential,
      );
      expect(agent.status).toBe(403);
      carriesNothing(agent);
    }
  });

  it('AW-03 client: a client shared on the scoped task sees neither body nor wrap-up', async () => {
    const client = await shareWithClient(w.fixture.db.app, w.fixture.business, w.owner, taskOne);
    const read = await readAs(client);
    expect([403, 404]).toContain(read.status);
    carriesNothing(read);
    const cli = await w.cli(client, 'conversation.read', { conversationId });
    expect([403, 404]).toContain(cli.status);
    carriesNothing(cli);
  });

  it('AW-03 canary: planted message content never reaches the audit payload, the register or an error', async () => {
    const rows = await w.fixture.db.admin.execute<{ readonly row: string }>(
      `select row_to_json(a)::text as row from public.audit_events a
       union all select row_to_json(r)::text from public.operations r`,
      [],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.row).not.toContain(canary);
    const bad = await w.as(w.owner, 'conversation.message', { conversationId, body: 7, canary });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(bad.body)).not.toContain(canary);
  });

  it('AW-03 revoked: with every grant revoked, no path returns a title, subject or owner name', async () => {
    await w.fixture.db.admin.execute(
      `update public.grants set revoked_at = now() where subject_id = $1 and revoked_at is null`,
      [w.owner.personId],
    );
    for (const answer of [
      // eslint-disable-next-line no-await-in-loop -- sequential reads of one world
      await readAs(w.owner),
      // eslint-disable-next-line no-await-in-loop
      await w.cli(w.owner, 'conversation.read', { conversationId }),
      // eslint-disable-next-line no-await-in-loop
      await w.as(w.owner, 'conversation.message', { conversationId, body: 'still here?' }),
    ]) {
      expect(answer.status).toBeGreaterThanOrEqual(400);
      carriesNothing(answer);
    }
  });
});
