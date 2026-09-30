// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-3 client groups, the read's half: an `inbox.read` entry carries its
// task's client, id and name, only where the reader reaches that client by
// C32's rule (`client.list`: a grant over the whole business, or one on that
// client). A reader who holds the task alone, on a record grant, reads the
// task and never learns its client. The client is read in the same
// transaction as the entry, never stored on the item.
//
// Separations, each with a stored canary client name that must never appear
// in a body: business to business, client to client in one business (the
// same-business wrong-client case), and a person under a live delegation (the
// agent reaches no inbox at all).

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { issueGrant, type Scope } from '../../packages/core-records/src/authority/grants.ts';
import { raiseInboxItem } from '../../packages/core-records/src/index.ts';
import { DELEGATION_HEADER, pathOf } from '../../packages/core-wire/src/surface.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { authorised, BUSINESS_KEY, post, tokenFor, type Answer } from '../api/fixture.ts';
import { clearingWorld, decideBody, ok } from '../commands/inbox-clearing-world.ts';

const serverUrl = databaseUrlFromEnvironment();

type Entry = Readonly<Record<string, unknown>>;

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(serverUrl === undefined)('MP-7-3 client groups over inbox.read', () => {
  const w = clearingWorld('m73g');
  let cora: Member;
  let coraToken = '';
  let bruno: Member;
  let brunoToken = '';

  const inboxAnswer = async (token: string, key = BUSINESS_KEY): Promise<Answer> =>
    await post(w.api, `/api/b/${key}${pathOf('inbox.read')}`, {}, authorised(token));
  const entry = async (token: string, id: string): Promise<Entry | undefined> =>
    (ok(await inboxAnswer(token)).body['inbox'] as Entry[]).find((e) => e['id'] === id);
  const client = async (name: string, business = w.fixture.business): Promise<string> => {
    const id = randomUUID();
    await w.fixture.db.admin.execute(
      `insert into public.clients (business_id, id, name, created_by_actor_id)
       values ($1, $2, $3, (select id from public.actors where business_id = $1 limit 1))`,
      [business, id, name],
    );
    return id;
  };
  const raise = async (recipient: string, subject: string, business = w.fixture.business) =>
    await w.fixture.db.app.withBusiness(
      business,
      async (tx) =>
        await raiseInboxItem(tx, {
          recipientPersonId: recipient,
          subjectRecordId: subject,
          reason: 'mention',
          fact: { kind: 'record', id: randomUUID() },
        }),
    );
  const grantCora = async (scope: Scope): Promise<void> =>
    await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      const issued = await issueGrant(tx, [], {
        subject: { kind: 'person', id: cora.personId },
        scope,
        collection: 'task',
        action: 'read',
        canDelegate: false,
        parentGrantId: null,
        grantedByActorId: w.fixture.member.actorId,
      });
      if (!issued.ok) throw new Error(issued.refusal.code);
    });

  beforeAll(async () => {
    cora = await enrol(w.fixture.db.app, w.fixture.business, 'Cora Grouped');
    coraToken = await tokenFor(cora.presented.subject);
    await installSpine(w.fixture.db.app, w.bravo);
    bruno = await enrol(w.fixture.db.app, w.bravo, 'Bruno Grouped');
    await w.fixture.db.app.withBusiness(w.bravo, async (tx) => {
      for (const action of ['read', 'write'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        await grantTo(tx, bruno, action);
      }
    });
    brunoToken = await tokenFor(bruno.presented.subject);
  }, 120_000);

  it('MP-7-3 client groups: a readable entry names its task’s client to a reader of the whole business, and a task on no client names none', async () => {
    const name = `Harbour Physio ${randomUUID().slice(0, 8)}`;
    const clientId = await client(name);
    const onClient = await w.task('on a client', clientId);
    const onNone = await w.task('on no client');
    const itemOn = await raise(w.fixture.member.personId, onClient.id);
    const itemNone = await raise(w.fixture.member.personId, onNone.id);

    expect(await entry(w.memberToken, itemOn)).toMatchObject({
      access: 'readable',
      client: { clientId, name },
    });
    expect(Object.keys((await entry(w.memberToken, itemNone)) ?? {})).not.toContain('client');
  });

  it('MP-7-3 client groups: the client is read at the read, so a renamed client reads renamed and the item stores none', async () => {
    const clientId = await client(`First Name ${randomUUID().slice(0, 8)}`);
    const item = await raise(w.fixture.member.personId, (await w.task('renamed', clientId)).id);
    const renamed = `Second Name ${randomUUID().slice(0, 8)}`;
    await w.fixture.db.admin.execute('update public.clients set name = $2 where id = $1', [
      clientId,
      renamed,
    ]);
    expect(await entry(w.memberToken, item)).toMatchObject({ client: { name: renamed } });
    const columns = await w.fixture.db.admin.execute<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'inbox_items'`,
    );
    expect(columns.map((c) => c.column_name)).not.toContain('client_name');
  });

  // eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
  describe('MP-7-3 isolation over the client groups', () => {
    it('same business, wrong client: a reader holding one task of another client reads the task but never its client, and a gone entry names no client', async () => {
      const ownName = `own-client-${randomUUID()}`;
      const wrongCanary = `wrong-client-canary-${randomUUID()}`;
      const own = await client(ownName);
      const wrong = await client(wrongCanary);
      const onOwn = await w.task('cora reads through her client', own);
      const onWrong = await w.task('cora reads this task alone', wrong);
      const trashed = await w.task('trashed on her client', own);
      await grantCora({ kind: 'party', id: own });
      await grantCora({ kind: 'record', id: onWrong.id });
      const itemOwn = await raise(cora.personId, onOwn.id);
      const itemWrong = await raise(cora.personId, onWrong.id);
      const itemGone = await raise(cora.personId, trashed.id);
      ok(await w.call('task.trash', { recordId: trashed.id, expectedRevision: trashed.rev }));

      const answer = ok(await inboxAnswer(coraToken)).body;
      const list = answer['inbox'] as Entry[];
      expect(list.find((e) => e['id'] === itemOwn)).toMatchObject({
        client: { clientId: own, name: ownName },
      });
      const wrongEntry = list.find((e) => e['id'] === itemWrong);
      expect(wrongEntry).toMatchObject({
        access: 'readable',
        task: { title: 'cora reads this task alone' },
      });
      expect(Object.keys(wrongEntry ?? {})).not.toContain('client');
      const gone = list.find((e) => e['id'] === itemGone);
      expect(gone).toMatchObject({ access: 'gone' });
      expect(Object.keys(gone ?? {})).not.toContain('client');
      const body = JSON.stringify(answer);
      expect(body).not.toContain(wrongCanary);
      expect(body).not.toContain(wrong);
    });

    it('business to business: another business’s client never reaches this inbox, and this one’s never reaches theirs', async () => {
      const alphaCanary = `alpha-client-canary-${randomUUID()}`;
      const bravoCanary = `bravo-client-canary-${randomUUID()}`;
      const alphaClient = await client(alphaCanary);
      await raise(w.fixture.member.personId, (await w.task('alpha task', alphaClient)).id);
      const bravoClient = await client(bravoCanary, w.bravo);
      const bravoTask = ok(
        await post(
          w.api,
          `/api/b/bravo${pathOf('task.create')}`,
          { operationId: randomUUID(), fields: { title: 'bravo task' } },
          authorised(brunoToken),
        ),
      ).body;
      await w.fixture.db.admin.execute(
        `update public.records set data = data || jsonb_build_object('client', $2::text)
          where id = $1`,
        [String(bravoTask['recordId']), bravoClient],
      );
      await raise(bruno.personId, String(bravoTask['recordId']), w.bravo);

      const bravoBody = JSON.stringify(ok(await inboxAnswer(brunoToken, 'bravo')).body);
      expect(bravoBody).toContain(bravoCanary);
      expect(bravoBody).not.toContain(alphaCanary);
      const refused = await inboxAnswer(brunoToken);
      expect(refused.status).not.toBe(200);
      expect(JSON.stringify(refused.body)).not.toContain(alphaCanary);
      const alphaBody = JSON.stringify(ok(await inboxAnswer(w.memberToken)).body);
      expect(alphaBody).toContain(alphaCanary);
      expect(alphaBody).not.toContain(bravoCanary);
    });

    it('a person under a live delegation: the agent reads no inbox and is told no client name', async () => {
      const canary = `delegated-client-canary-${randomUUID()}`;
      const p = await w.proposed('delegated grouping', await client(canary));
      const decided = ok(await w.call('task.decide', decideBody(p), w.memberToken)).body;
      const detail = (decided['detail'] as Record<string, unknown> | undefined) ?? decided;
      const agentToken = await tokenFor(w.fixture.agent.subject);
      const pickedUp = await post(
        w.api,
        `/api/a/b/${BUSINESS_KEY}${pathOf('task.pickup')}`,
        { operationId: randomUUID(), reservationId: detail['reservationId'] },
        authorised(agentToken),
      );
      expect(pickedUp.status, String(pickedUp.body['code'])).toBe(200);
      const picked =
        (pickedUp.body['detail'] as Record<string, unknown> | undefined) ?? pickedUp.body;
      const agent = await post(
        w.api,
        `/api/a/b/${BUSINESS_KEY}${pathOf('inbox.read')}`,
        {},
        { ...authorised(agentToken), [DELEGATION_HEADER]: String(picked['credential']) },
      );
      expect(agent.status).not.toBe(200);
      expect(JSON.stringify(agent.body)).not.toContain(canary);
      expect(JSON.stringify(ok(await inboxAnswer(w.reviewerToken)).body)).toContain(canary);
    });
  });
});
