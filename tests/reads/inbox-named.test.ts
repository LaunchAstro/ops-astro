// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1g: the inbox names what it points at, for the working minimum inside
// Tasks (supporting checklist: "A cleared item names who decided", the owner's
// check, and the isolation line over the read the screen draws).
//
// A readable entry carries its task's key and title and, once closed, the
// decider's name, all read in the same transaction as the access that allows
// them. The item stores none of it, so a renamed task reads renamed. An entry
// the caller cannot read names nothing: a withheld one is not listed and a
// gone one carries no task and no decider.
//
// Separations, each with a stored canary title that must never appear in a
// body: business to business, client to client in one business, and a person
// under a live delegation (the agent reaches no inbox at all).

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { raiseInboxItem } from '../../packages/core-records/src/index.ts';
import { DELEGATION_HEADER, pathOf } from '../../packages/core-wire/src/surface.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { authorised, BUSINESS_KEY, post, tokenFor, type Answer } from '../api/fixture.ts';
import { clearingWorld, decideBody, ok } from '../commands/inbox-clearing-world.ts';

const serverUrl = databaseUrlFromEnvironment();

type Entry = Readonly<Record<string, unknown>>;

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(serverUrl === undefined)('INB-1g the inbox names what it points at', () => {
  const w = clearingWorld('i1g');
  let cora: Member;
  let coraToken = '';
  let bruno: Member;
  let brunoToken = '';

  const inboxAnswer = async (token: string, key = BUSINESS_KEY): Promise<Answer> =>
    await post(w.api, `/api/b/${key}${pathOf('inbox.read')}`, {}, authorised(token));
  const inbox = async (token: string, key = BUSINESS_KEY): Promise<readonly Entry[]> =>
    ok(await inboxAnswer(token, key)).body['inbox'] as Entry[];
  const { task } = w;
  const keyOf = async (id: string): Promise<string> =>
    String(
      (
        await w.fixture.db.admin.execute<{ key: string }>(
          'select txt_1 as key from public.records where id = $1',
          [id],
        )
      )[0]?.key,
    );
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
  const nameOf = async (personId: string): Promise<string> =>
    String(
      (
        await w.fixture.db.admin.execute<{ name: string }>(
          'select display_name as name from public.people where id = $1',
          [personId],
        )
      )[0]?.name,
    );

  beforeAll(async () => {
    cora = await enrol(w.fixture.db.app, w.fixture.business, 'Cora Named');
    coraToken = await tokenFor(cora.presented.subject);
    await installSpine(w.fixture.db.app, w.bravo);
    bruno = await enrol(w.fixture.db.app, w.bravo, 'Bruno Named');
    await w.fixture.db.app.withBusiness(w.bravo, async (tx) => {
      for (const action of ['read', 'write'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        await grantTo(tx, bruno, action);
      }
    });
    brunoToken = await tokenFor(bruno.presented.subject);
  }, 120_000);

  it('INB-1 a cleared item names who decided: the other reviewer’s item closes on the deciding commit and names the decider', async () => {
    const p = await w.proposed('second reviewer decides');
    const before = (await inbox(w.reviewerToken)).find((e) => e['factId'] === p.gateId);
    expect(before).toMatchObject({
      workState: 'open',
      counted: true,
      task: { key: await keyOf(p.task.id), title: 'second reviewer decides' },
      closedBy: null,
    });

    ok(await w.call('task.decide', decideBody(p), w.memberToken));
    const after = (await inbox(w.reviewerToken)).find((e) => e['id'] === before?.['id']);
    expect(after).toMatchObject({
      workState: 'cleared',
      counted: false,
      closedBy: {
        personId: w.fixture.member.personId,
        name: await nameOf(w.fixture.member.personId),
      },
    });
  });

  it('INB-1 the inbox names its task at the read: a renamed task reads renamed, and the item stores no title', async () => {
    const t = await task('first name');
    const item = await raise(w.reviewer.personId, t.id);
    await w.fixture.db.admin.execute(
      `update public.records set data = data || jsonb_build_object('title', 'second name')
        where id = $1`,
      [t.id],
    );
    expect((await inbox(w.reviewerToken)).find((e) => e['id'] === item)).toMatchObject({
      task: { title: 'second name' },
    });
    const columns = await w.fixture.db.admin.execute<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'inbox_items'`,
    );
    expect(columns.map((c) => c.column_name)).not.toContain('title');
  });

  // eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
  describe('INB-1 isolation over the named inbox', () => {
    it('business to business: neither business’s task names reach the other’s inbox', async () => {
      const alphaCanary = `alpha-canary-${randomUUID()}`;
      const bravoCanary = `bravo-canary-${randomUUID()}`;
      const alphaTask = await task(alphaCanary);
      await raise(w.fixture.member.personId, alphaTask.id);
      const bravoTask = ok(
        await post(
          w.api,
          `/api/b/bravo${pathOf('task.create')}`,
          { operationId: randomUUID(), fields: { title: bravoCanary } },
          authorised(brunoToken),
        ),
      ).body;
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

    it('client to client, in one business: a withheld or gone entry names no task and no decider', async () => {
      const clientA = randomUUID();
      const aCanary = `client-a-canary-${randomUUID()}`;
      const bCanary = `client-b-canary-${randomUUID()}`;
      const goneCanary = `gone-canary-${randomUUID()}`;
      const onA = await task(aCanary, clientA);
      const onB = await task(bCanary, randomUUID());
      const trashed = await task(goneCanary, clientA);
      await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
        const issued = await issueGrant(tx, [], {
          subject: { kind: 'person', id: cora.personId },
          scope: { kind: 'party', id: clientA },
          collection: 'task',
          action: 'read',
          canDelegate: false,
          parentGrantId: null,
          grantedByActorId: w.fixture.member.actorId,
        });
        if (!issued.ok) throw new Error(issued.refusal.code);
      });
      const itemA = await raise(cora.personId, onA.id);
      const itemB = await raise(cora.personId, onB.id);
      const itemGone = await raise(cora.personId, trashed.id);
      ok(await w.call('task.trash', { recordId: trashed.id, expectedRevision: trashed.rev }));

      const answer = ok(await inboxAnswer(coraToken)).body;
      const list = answer['inbox'] as Entry[];
      expect(list.find((e) => e['id'] === itemA)).toMatchObject({ task: { title: aCanary } });
      expect(list.map((e) => e['id'])).not.toContain(itemB);
      const gone = list.find((e) => e['id'] === itemGone);
      expect(gone).toMatchObject({ access: 'gone' });
      expect(Object.keys(gone ?? {})).not.toContain('task');
      expect(Object.keys(gone ?? {})).not.toContain('closedBy');
      const body = JSON.stringify(answer);
      expect(body).not.toContain(bCanary);
      expect(body).not.toContain(onB.id);
      expect(body).not.toContain(goneCanary);
    });

    it('a person under a live delegation: the agent reads no inbox and is told no task name', async () => {
      const canary = `delegated-canary-${randomUUID()}`;
      const p = await w.proposed(canary);
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
      const credential = String(picked['credential']);

      for (const name of ['inbox.read', 'inbox.count'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        const agent = await post(
          w.api,
          `/api/a/b/${BUSINESS_KEY}${pathOf(name)}`,
          {},
          {
            ...authorised(agentToken),
            [DELEGATION_HEADER]: credential,
          },
        );
        expect(agent.status, name).not.toBe(200);
        expect(JSON.stringify(agent.body), name).not.toContain(canary);
      }
      expect(JSON.stringify(ok(await inboxAnswer(w.reviewerToken)).body)).toContain(canary);
    });
  });
});
