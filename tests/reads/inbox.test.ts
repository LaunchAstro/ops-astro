// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- one database world, and the cases that share it */
//
// INB-1d: the inbox read and the owed count, on the API and the command line
// (supporting checklist lines C3, C8, C10, C19, C35 and C37).
//
// One permission-checked read serves the list, and the count is that same
// read's counted entries: open, owed and readable now. Access is derived at the
// read, so a lost grant withholds an item at the next read without touching it
// (withheld items are not listed), and withheld is not gone. `seen` is the recipient's own attention row, written
// by `inbox.seen` for the caller's own item only. No worker runs anywhere in
// this suite: the fixture composes the API alone, so every count here is the
// count with the dispatching worker stopped.
//
// Separations, each exercised below: business to business (another business's
// person reads, counts and stamps nothing here, and this business's items never
// reach theirs), client to client (a party grant on client A shows A's item and
// neither lists nor stamps B's, in one business), person to person (a read returns the
// caller's items only, and nobody stamps another person's item).

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { issueGrant, revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import {
  raiseInboxItem,
  recordDeliveryAttempt,
  type InboxReason,
} from '../../packages/core-records/src/index.ts';
import { pathOf, type CommandName } from '../../packages/core-wire/src/surface.ts';
import { createCli, type Transport } from '../../apps/cli/client.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { authorised, BUSINESS_KEY, post, tokenFor, type Answer } from '../api/fixture.ts';
import { clearingWorld, decideBody, ok } from '../commands/inbox-clearing-world.ts';

const serverUrl = databaseUrlFromEnvironment();

/** A route by its surface name, as the command line builds it. */
const route = (name: string): string => pathOf(name as CommandName);

type Entry = Readonly<Record<string, unknown>>;

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(serverUrl === undefined)('INB-1d the inbox read and count', () => {
  const w = clearingWorld('i1d');
  let dee: Member;
  let deeToken = '';
  let cora: Member;
  let coraToken = '';
  let bruno: Member;
  let brunoToken = '';

  const read = async (name: string, token: string, key = BUSINESS_KEY): Promise<Answer> =>
    await w.send(name, token, {}, key);
  const inbox = async (token: string): Promise<readonly Entry[]> =>
    ok(await read('inbox.read', token)).body['inbox'] as Entry[];
  const owed = async (token: string): Promise<number> =>
    Number(ok(await read('inbox.count', token)).body['owed']);
  const seen = async (itemId: string, token: string, key = BUSINESS_KEY): Promise<Answer> =>
    await w.send('inbox.seen', token, { operationId: randomUUID(), itemId }, key);
  const entry = async (token: string, id: string): Promise<Entry | undefined> =>
    (await inbox(token)).find((e) => e['id'] === id);

  const inAlpha = async <T>(work: Parameters<typeof w.fixture.db.app.withBusiness>[1]) =>
    (await w.fixture.db.app.withBusiness(w.fixture.business, work)) as T;
  const raise = async (
    recipient: string,
    task: string,
    reason: InboxReason = 'mention',
    business = w.fixture.business,
  ): Promise<string> =>
    await w.fixture.db.app.withBusiness(
      business,
      async (tx) =>
        await raiseInboxItem(tx, {
          recipientPersonId: recipient,
          subjectRecordId: task,
          reason,
          fact:
            reason === 'run_finished'
              ? { kind: 'planned_run', id: randomUUID() }
              : { kind: 'record', id: randomUUID() },
        }),
    );
  const grantRead = async (who: Member, scope: { kind: 'record' | 'party'; id: string }) =>
    await inAlpha<string>(async (tx) => {
      const issued = await issueGrant(tx, [], {
        subject: { kind: 'person', id: who.personId },
        scope,
        collection: 'task',
        action: 'read',
        canDelegate: false,
        parentGrantId: null,
        grantedByActorId: w.fixture.member.actorId,
      });
      if (!issued.ok) throw new Error(`grantRead: ${issued.refusal.code}`);
      return issued.value;
    });
  const { task } = w;
  const attention = async (itemId: string): Promise<readonly string[]> =>
    (
      await w.fixture.db.admin.execute<{ person_id: string }>(
        `select person_id from public.inbox_attention where item_id = $1`,
        [itemId],
      )
    ).map((row) => row.person_id);
  const stored = async (itemId: string): Promise<string | undefined> =>
    (
      await w.fixture.db.admin.execute<{ work_state: string }>(
        `select work_state from public.inbox_items where id = $1`,
        [itemId],
      )
    )[0]?.work_state;

  beforeAll(async () => {
    dee = await enrol(w.fixture.db.app, w.fixture.business, 'Dee Record');
    cora = await enrol(w.fixture.db.app, w.fixture.business, 'Cora Client');
    deeToken = await tokenFor(dee.presented.subject);
    coraToken = await tokenFor(cora.presented.subject);
    await installSpine(w.fixture.db.app, w.bravo);
    bruno = await enrol(w.fixture.db.app, w.bravo, 'Bruno Login');
    await w.fixture.db.app.withBusiness(w.bravo, async (tx) => {
      for (const action of ['read', 'write'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        await grantTo(tx, bruno, action);
      }
    });
    brunoToken = await tokenFor(bruno.presented.subject);
  }, 120_000);

  it('INB-1 count equals list: the count is the list’s counted entries, with no worker, and drops on the deciding commit', async () => {
    const p = await w.proposed('count me');
    const finished = await raise(w.fixture.member.personId, p.task.id, 'run_finished');
    const before = await inbox(w.memberToken);
    const counted = before.filter((e) => e['counted'] === true);
    expect(await owed(w.memberToken)).toBe(counted.length);
    const decision = before.find((e) => e['reason'] === 'decision' && e['factId'] === p.gateId);
    expect(decision).toMatchObject({ workState: 'open', access: 'readable', counted: true });
    expect(before.find((e) => e['id'] === finished)).toMatchObject({ counted: false });

    ok(await w.call('task.decide', decideBody(p), w.reviewerToken));
    const after = await inbox(w.memberToken);
    expect(await owed(w.memberToken)).toBe(counted.length - 1);
    expect(after.filter((e) => e['counted'] === true)).toHaveLength(counted.length - 1);
    expect(after.find((e) => e['id'] === decision?.['id'])).toMatchObject({
      workState: 'cleared',
      closedByPersonId: w.reviewer.personId,
      counted: false,
    });
  });

  it('INB-1 withheld: access lost after raising withholds the item at the next read, and withheld is not gone', async () => {
    const t = await task('withhold me');
    // Dee keeps a grant elsewhere: a caller holding none is refused outright.
    await grantRead(dee, { kind: 'record', id: (await task('dee elsewhere')).id });
    const grant = await grantRead(dee, { kind: 'record', id: t.id });
    const item = await raise(dee.personId, t.id);
    expect(await entry(deeToken, item)).toMatchObject({
      access: 'readable',
      counted: true,
      subjectRecordId: t.id,
    });
    expect(await owed(deeToken)).toBe(1);

    await inAlpha(async (tx) => {
      await revokeGrant(tx, grant);
    });
    // Withheld at the next read: not listed, not counted, and still stored.
    expect(await entry(deeToken, item)).toBeUndefined();
    expect(await owed(deeToken)).toBe(0);
    expect(await stored(item)).toBe('open');

    await grantRead(dee, { kind: 'record', id: t.id });
    expect(await entry(deeToken, item)).toMatchObject({ access: 'readable', counted: true });
  });

  describe('INB-1 read is not done', () => {
    it('reading the list and opening an item leave it open and counted', async () => {
      const p = await w.proposed('read me');
      const mine = (await inbox(w.reviewerToken)).find((e) => e['factId'] === p.gateId);
      const id = String(mine?.['id']);
      const count = await owed(w.reviewerToken);
      await inbox(w.reviewerToken);
      ok(await seen(id, w.reviewerToken));
      expect(await entry(w.reviewerToken, id)).toMatchObject({ workState: 'open', counted: true });
      expect(await owed(w.reviewerToken)).toBe(count);
      expect(await stored(id)).toBe('open');
    });

    it('delivered is not seen, and seen writes no delivery', async () => {
      const t = await task('deliver me');
      const item = await raise(w.reviewer.personId, t.id);
      await inAlpha(async (tx) => {
        await recordDeliveryAttempt(tx, { itemId: item, channel: 'in_app', state: 'delivered' });
      });
      expect(await entry(w.reviewerToken, item)).toMatchObject({
        lastDelivery: 'delivered',
        seenAt: null,
      });
      ok(await seen(item, w.reviewerToken));
      const opened = await entry(w.reviewerToken, item);
      expect(opened).toMatchObject({ lastDelivery: 'delivered' });
      expect(opened?.['seenAt']).toEqual(expect.any(String));
      const [attempts] = await w.fixture.db.admin.execute<{ n: string }>(
        `select count(*)::text as n from public.inbox_delivery_attempts where item_id = $1`,
        [item],
      );
      expect(attempts?.n).toBe('1');
    });

    it('gone is its own state: a trashed task’s item is gone, never withheld, and still stored', async () => {
      const t = await task('trash me');
      await grantRead(dee, { kind: 'record', id: t.id });
      const item = await raise(dee.personId, t.id);
      ok(await w.call('task.trash', { recordId: t.id, expectedRevision: t.rev }));
      expect(await entry(deeToken, item)).toMatchObject({ access: 'gone', counted: false });
      expect(await stored(item)).toBe('open');
    });
  });

  it('INB-1 seen self-scoped: only the recipient stamps their own item; another person and an agent write nothing', async () => {
    const t = await task('stamp me');
    const item = await raise(w.reviewer.personId, t.id);

    const other = await seen(item, w.memberToken);
    expect(other.body['code']).toBe('NOT_FOUND');
    const agent = await post(
      w.api,
      `/api/a/b/${BUSINESS_KEY}${route('inbox.seen')}`,
      { operationId: randomUUID(), itemId: item },
      authorised(await tokenFor(w.fixture.agent.subject)),
    );
    expect(agent.status).not.toBe(200);
    expect(await attention(item)).toStrictEqual([]);

    ok(await seen(item, w.reviewerToken));
    ok(await seen(item, w.reviewerToken));
    expect(await attention(item)).toStrictEqual([w.reviewer.personId]);
  });

  // eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
  describe('INB-1 isolation over the read, the count and the stamp', () => {
    it('wrong-client item is not listed', async () => {
      const recipient = await enrol(w.fixture.db.app, w.fixture.business, 'Sol Client Read');
      const token = await tokenFor(recipient.presented.subject);
      const clientA = randomUUID();
      const onA = await task('Sol readable client task', clientA);
      const onB = await task('Sol other client task', randomUUID());
      await grantRead(recipient, { kind: 'party', id: clientA });
      const own = await raise(recipient.personId, onA.id);
      const foreign = await raise(recipient.personId, onB.id);

      const listed = await inbox(token);
      expect(listed.map((item) => item['id'])).toContain(own);
      expect(listed.map((item) => item['id'])).not.toContain(foreign);
      expect(await owed(token)).toBe(1);
    });

    it('wrong-client item cannot be stamped', async () => {
      const recipient = await enrol(w.fixture.db.app, w.fixture.business, 'Sol Client Stamp');
      const token = await tokenFor(recipient.presented.subject);
      const clientA = randomUUID();
      await grantRead(recipient, { kind: 'party', id: clientA });
      const onB = await task('Sol unshared client task', randomUUID());
      const foreign = await raise(recipient.personId, onB.id);

      const response = await seen(foreign, token);
      expect(response.status).toBe(404);
      expect(response.body['code']).toBe('NOT_FOUND');
      expect(await attention(foreign)).toStrictEqual([]);
    });

    it('business to business', async () => {
      const bravoTask = ok(
        await post(
          w.api,
          `/api/b/bravo${pathOf('task.create')}`,
          { operationId: randomUUID(), fields: { title: 'bravo work' } },
          authorised(brunoToken),
        ),
      ).body;
      const brunoItem = await raise(
        bruno.personId,
        String(bravoTask['recordId']),
        'mention',
        w.bravo,
      );
      const alphaItem = await raise(w.fixture.member.personId, (await task('alpha only')).id);

      expect((await read('inbox.read', brunoToken)).status).not.toBe(200);
      expect((await read('inbox.count', brunoToken)).status).not.toBe(200);
      const bravoList = ok(await read('inbox.read', brunoToken, 'bravo')).body['inbox'] as Entry[];
      expect(bravoList.map((e) => e['id'])).toStrictEqual([brunoItem]);
      expect(Number(ok(await read('inbox.count', brunoToken, 'bravo')).body['owed'])).toBe(1);
      expect((await inbox(w.memberToken)).map((e) => e['id'])).not.toContain(brunoItem);

      expect((await seen(alphaItem, brunoToken, 'bravo')).body['code']).toBe('NOT_FOUND');
      expect((await seen(brunoItem, w.memberToken)).body['code']).toBe('NOT_FOUND');
      expect(await attention(alphaItem)).toStrictEqual([]);
      expect(await attention(brunoItem)).toStrictEqual([]);
    });

    it('client to client, in one business', async () => {
      const clientA = randomUUID();
      const onA = await task('client A work', clientA);
      const onB = await task('client B work', randomUUID());
      await grantRead(cora, { kind: 'party', id: clientA });
      const itemA = await raise(cora.personId, onA.id);
      const itemB = await raise(cora.personId, onB.id);
      const list = await inbox(coraToken);
      expect(list.find((e) => e['id'] === itemA)).toMatchObject({
        access: 'readable',
        subjectRecordId: onA.id,
      });
      // Client B's item is withheld: not listed at all, so its existence is not told.
      expect(list.map((e) => e['id'])).not.toContain(itemB);
      expect(await owed(coraToken)).toBe(1);
    });

    it('person to person', async () => {
      const p = await w.proposed('two holders');
      const items = await w.fixture.db.admin.execute<{ id: string; recipient: string }>(
        `select id, recipient_person_id as recipient from public.inbox_items where fact_id = $1`,
        [p.gateId],
      );
      const mine = items.find((i) => i.recipient === w.fixture.member.personId)?.id;
      const theirs = items.find((i) => i.recipient === w.reviewer.personId)?.id;
      const memberIds = (await inbox(w.memberToken)).map((e) => e['id']);
      const reviewerIds = (await inbox(w.reviewerToken)).map((e) => e['id']);
      expect(memberIds).toContain(mine);
      expect(memberIds).not.toContain(theirs);
      expect(reviewerIds).toContain(theirs);
      expect(reviewerIds).not.toContain(mine);
      expect(await inbox(w.writerToken)).toStrictEqual([]);
      expect(await owed(w.writerToken)).toBe(0);
    });
  });

  it('the command line reaches the read, the count and the stamp by their surface rows alone', async () => {
    const transport: Transport = async (path, body, bearer) =>
      await w.api.fetch(
        new Request(`http://api.test${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
          body,
        }),
      );
    const cli = createCli({ transport, businessKey: BUSINESS_KEY, credential: w.reviewerToken });
    const listed = await cli.run('inbox.read', {});
    expect(listed.status).toBe(200);
    expect(listed.body).toStrictEqual({ ok: true, inbox: await inbox(w.reviewerToken) });
    const counted = await cli.run('inbox.count', {});
    expect(counted.body).toStrictEqual({ ok: true, owed: await owed(w.reviewerToken) });
    const first = (listed.body as { inbox: Entry[] }).inbox[0];
    const stamped = await cli.run('inbox.seen', {
      operationId: randomUUID(),
      itemId: first?.['id'],
    });
    expect(stamped.status).toBe(200);
  });
});
