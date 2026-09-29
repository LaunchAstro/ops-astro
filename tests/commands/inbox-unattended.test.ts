// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1e: unattended (supporting checklist lines C14 and C30). Escalation
// parked and settings per channel (C20, C36) are `inbox-escalation-settings.test.ts`.
//
// An item is `unattended` only when every path to a person is broken. A path is
// one recipient of the obligation who can sign in (an active login, acting
// identity and membership), can read the task, and for a decision still holds
// `task:decide` on it; a decision or an incident is one obligation shared by
// everyone raised an item on it, anything else is its recipient's own. In-app
// is the only channel on this head and is always on, so a person who can sign
// in and read is reachable. Nothing is inferred from time or from silence: an
// old unseen item with one live path stays attended. Until the operations view
// (C55) lands, the list is `inbox.unattended` on the API and the command line,
// behind `operations:read`, and it writes nothing.
//
// Separations, each exercised below: business to business (an operator of
// another business lists none of this business's items, and this business's
// operator none of theirs), client to client (an operator reading only client
// A's tasks lists A's unattended item and not B's, in one business), person to
// person (a member without `operations:read` is refused the list, so nobody
// reads another person's items through it).

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { revokeGrant, type Scope } from '../../packages/core-records/src/authority/grants.ts';
import { raiseInboxItem, type InboxReason } from '../../packages/core-records/src/index.ts';
import { COMMAND_SURFACE, pathOf, type CommandName } from '../../packages/core-wire/src/surface.ts';
import { createCli, type Transport } from '../../apps/cli/client.ts';
import { enrol, grantTo, installSpine, WHOLE_BUSINESS, type Member } from './fixture.ts';
import { authorised, BUSINESS_KEY, post, tokenFor, type Answer } from '../api/fixture.ts';
import { clearingWorld, ok } from './inbox-clearing-world.ts';

const serverUrl = databaseUrlFromEnvironment();

type Entry = Readonly<Record<string, unknown>>;

/** A route by its surface name, as the command line builds it. */
const route = (name: string): string => pathOf(name as CommandName);

const CLIENT_A = randomUUID();
const CLIENT_B = randomUUID();

describe.skipIf(serverUrl === undefined)('INB-1e unattended', () => {
  const w = clearingWorld('i1e');
  let opal: Member;
  let opalToken = '';
  let otto: Member;
  let ottoToken = '';
  let pim: Member;
  let pimToken = '';
  let bruno: Member;
  let brunoToken = '';

  const call = async (
    name: string,
    token: string,
    body: Readonly<Record<string, unknown>> = {},
    key = BUSINESS_KEY,
  ): Promise<Answer> => await post(w.api, `/api/b/${key}${route(name)}`, body, authorised(token));
  const unattended = async (token: string, key = BUSINESS_KEY): Promise<readonly Entry[]> =>
    ok(await call('inbox.unattended', token, {}, key)).body['unattended'] as Entry[];
  const listed = async (token: string = opalToken): Promise<readonly string[]> =>
    (await unattended(token)).map((entry) => String(entry['id']));
  const inAlpha = async <T>(work: Parameters<typeof w.fixture.db.app.withBusiness>[1]) =>
    (await w.fixture.db.app.withBusiness(w.fixture.business, work)) as T;
  const task = async (title: string, client?: string, token = w.memberToken): Promise<string> => {
    const created = ok(
      await call('task.create', token, { operationId: randomUUID(), fields: { title } }),
    );
    const id = String(created.body['recordId']);
    if (client !== undefined) {
      await w.fixture.db.admin.execute(
        `update public.records set data = data || jsonb_build_object('client', $2::text)
          where id = $1`,
        [id, client],
      );
    }
    return id;
  };
  const raise = async (
    recipient: string,
    subject: string,
    reason: InboxReason,
    factId: string = randomUUID(),
    business = w.fixture.business,
  ): Promise<string> =>
    await w.fixture.db.app.withBusiness(
      business,
      async (tx) =>
        await raiseInboxItem(tx, {
          recipientPersonId: recipient,
          subjectRecordId: subject,
          reason,
          fact: { kind: reason === 'decision' ? 'gate' : 'record', id: factId },
        }),
    );
  /** A person with read (and decide, for a decider) on one task only. */
  const onTask = async (
    name: string,
    subject: string,
    actions: readonly ('read' | 'decide')[],
  ): Promise<{ member: Member; grants: Record<string, string> }> => {
    const member = await enrol(w.fixture.db.app, w.fixture.business, name);
    const grants: Record<string, string> = {};
    await inAlpha(async (tx) => {
      for (const action of actions) {
        // oxlint-disable-next-line no-await-in-loop
        grants[action] = await grantTo(tx, member, action, { kind: 'record', id: subject });
      }
    });
    return { member, grants };
  };
  const revoke = async (grantId: string): Promise<void> => {
    await inAlpha(async (tx) => await revokeGrant(tx, grantId));
  };
  const deactivate = async (who: Member, path: 'login' | 'actor' | 'membership'): Promise<void> => {
    const sql = {
      login: `update public.person_logins set active = false, deactivated_at = now()
               where person_id = $1 and active`,
      actor: `update public.actors set active = false, deactivated_at = now()
               where person_id = $1 and kind = 'person' and active`,
      membership: `update public.memberships set active = false, ended_at = now()
                    where person_id = $1 and active`,
    }[path];
    await w.fixture.db.admin.execute(sql, [who.personId]);
  };
  const itemCount = async (): Promise<number> =>
    Number(
      (
        await w.fixture.db.admin.execute<{ n: string }>(
          `select count(*)::text as n from public.inbox_items where business_id = $1`,
          [w.fixture.business],
        )
      )[0]?.n,
    );
  beforeAll(async () => {
    opal = await enrol(w.fixture.db.app, w.fixture.business, 'Opal Operator');
    otto = await enrol(w.fixture.db.app, w.fixture.business, 'Otto Client Operator');
    pim = await enrol(w.fixture.db.app, w.fixture.business, 'Pim Plain');
    await inAlpha(async (tx) => {
      await grantTo(tx, opal, 'read');
      await grantTo(tx, opal, 'read', WHOLE_BUSINESS, false, 'operations');
      await grantTo(tx, otto, 'read', { kind: 'party', id: CLIENT_A } as Scope);
      await grantTo(tx, otto, 'read', WHOLE_BUSINESS, false, 'operations');
      await grantTo(tx, pim, 'read');
    });
    opalToken = await tokenFor(opal.presented.subject);
    ottoToken = await tokenFor(otto.presented.subject);
    pimToken = await tokenFor(pim.presented.subject);
    await installSpine(w.fixture.db.app, w.bravo);
    bruno = await enrol(w.fixture.db.app, w.bravo, 'Bruno Operator');
    await w.fixture.db.app.withBusiness(w.bravo, async (tx) => {
      for (const action of ['read', 'write'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        await grantTo(tx, bruno, action);
      }
      await grantTo(tx, bruno, 'read', WHOLE_BUSINESS, false, 'operations');
    });
    brunoToken = await tokenFor(bruno.presented.subject);
  }, 120_000);

  describe('INB-1 unattended every path', () => {
    it('a decision becomes unattended only when every decider is cut off, and one live path keeps it attended', async () => {
      const subject = await task('two deciders');
      const gate = randomUUID();
      const dee = await onTask('Dee Decider', subject, ['read', 'decide']);
      const dan = await onTask('Dan Decider', subject, ['read', 'decide']);
      const deeItem = await raise(dee.member.personId, subject, 'decision', gate);
      const danItem = await raise(dan.member.personId, subject, 'decision', gate);
      expect(await listed()).not.toContain(deeItem);

      // Dee can still sign in and read, but no longer decides: her path is
      // broken, and Dan's keeps the shared decision attended.
      await revoke(dee.grants['decide'] ?? '');
      expect(await listed()).not.toContain(deeItem);
      expect(await listed()).not.toContain(danItem);

      // Dan's login is switched off: the last path is broken.
      await deactivate(dan.member, 'login');
      const both = await listed();
      expect(both).toContain(deeItem);
      expect(both).toContain(danItem);

      // One path restored (Dee decides again): attended at the next read.
      await inAlpha(async (tx) => {
        await grantTo(tx, dee.member, 'decide', { kind: 'record', id: subject });
      });
      const after = await listed();
      expect(after).not.toContain(deeItem);
      expect(after).not.toContain(danItem);
    });

    it.each(['login', 'actor'] as const)(
      'a mention whose recipient loses their %s is unattended',
      async (path) => {
        const subject = await task(`mention, ${path}`);
        const mia = await onTask(`Mia ${path}`, subject, ['read']);
        const item = await raise(mia.member.personId, subject, 'mention');
        expect(await listed()).not.toContain(item);
        await deactivate(mia.member, path);
        expect(await listed()).toContain(item);
      },
    );

    it('an ended membership breaks the path of a former member, not of a person standing on a share', async () => {
      const subject = await task('mention, membership');
      const former = await onTask('Fay Former', subject, ['read']);
      await inAlpha(async (tx) => {
        await grantTo(tx, former.member, 'comment');
      });
      const shared = await onTask('Sal Shared', subject, ['read']);
      const formerItem = await raise(former.member.personId, subject, 'mention');
      const sharedItem = await raise(shared.member.personId, subject, 'mention');
      await deactivate(former.member, 'membership');
      await deactivate(shared.member, 'membership');
      // Login resolution still admits Sal on her share; Fay's business grant
      // makes her a former member, whom it refuses.
      const now = await listed();
      expect(now).toContain(formerItem);
      expect(now).not.toContain(sharedItem);
    });

    it('a recipient who can no longer read the task is a broken path; another recipient of their own mention is not a path to it', async () => {
      const subject = await task('mention, withheld');
      const comment = randomUUID();
      const mo = await onTask('Mo Withheld', subject, ['read']);
      const max = await onTask('Max Reader', subject, ['read']);
      const moItem = await raise(mo.member.personId, subject, 'mention', comment);
      const maxItem = await raise(max.member.personId, subject, 'mention', comment);
      await revoke(mo.grants['read'] ?? '');
      const now = await listed();
      expect(now).toContain(moItem);
      expect(now).not.toContain(maxItem);
    });

    it('never inferred: an old, unseen, undelivered item with a live path stays attended', async () => {
      const subject = await task('old and quiet');
      const quiet = await onTask('Quinn Quiet', subject, ['read', 'decide']);
      const item = await raise(quiet.member.personId, subject, 'decision');
      await w.fixture.db.admin.execute(
        `update public.inbox_items set raised_at = now() - interval '400 days' where id = $1`,
        [item],
      );
      expect(await listed()).not.toContain(item);
    });

    it('only open items on a task that is there can be unattended', async () => {
      const subject = await task('closed and not owed');
      const gone = await onTask('Gil Gone', subject, ['read']);
      const finished = await raise(gone.member.personId, subject, 'run_finished');
      const withdrawn = await raise(gone.member.personId, subject, 'assignment');
      await w.fixture.db.admin.execute(
        `update public.inbox_items set work_state = 'withdrawn', closed_at = now() where id = $1`,
        [withdrawn],
      );
      const trashedTask = await task('trashed');
      const trashed = await raise(gone.member.personId, trashedTask, 'mention');
      await w.fixture.db.admin.execute(
        `update public.records
            set deleted_at = now(), deleted_by_actor_id = $2, trash_batch_id = gen_random_uuid()
          where id = $1`,
        [trashedTask, w.fixture.member.actorId],
      );
      await deactivate(gone.member, 'login');
      const now = await listed();
      expect(now).toContain(finished);
      expect(now).not.toContain(withdrawn);
      expect(now).not.toContain(trashed);
    });

    it('Sol proof, criterion 33: a no-response item becomes unattended when its only path breaks', async () => {
      const subject = await task('finished run, recipient offline');
      const recipient = await onTask('Rae Run Recipient', subject, ['read']);
      const item = await raise(recipient.member.personId, subject, 'run_finished');
      const before = await w.fixture.db.admin.execute<{ owed: boolean; work_state: string }>(
        `select owed, work_state from public.inbox_items where id = $1`,
        [item],
      );
      expect(before).toHaveLength(1);
      expect(before[0]?.owed).toBe(false);
      expect(before[0]?.work_state).toBe('open');
      expect(await listed()).not.toContain(item);
      await deactivate(recipient.member, 'login');
      expect(await listed()).toContain(item);
    });

    it('the read writes nothing: the items stay open and nothing is raised', async () => {
      const before = await itemCount();
      const listedNow = await unattended(opalToken);
      expect(listedNow.length).toBeGreaterThan(0);
      expect(await itemCount()).toBe(before);
      const ids = listedNow.map((entry) => String(entry['id']));
      const states = await w.fixture.db.admin.execute<{ work_state: string }>(
        `select work_state from public.inbox_items where id = any($1::uuid[])`,
        [ids],
      );
      expect(new Set(states.map((row) => row.work_state))).toStrictEqual(new Set(['open']));
    });
  });

  describe('INB-1 unattended readable on the API and command line', () => {
    it('each entry names the item, its recipient, reason and task, and the command line answers the same', async () => {
      const subject = await task('both surfaces');
      const lone = await onTask('Lee Lone', subject, ['read']);
      const item = await raise(lone.member.personId, subject, 'assignment');
      await deactivate(lone.member, 'actor');
      const entry = (await unattended(opalToken)).find((e) => e['id'] === item);
      expect(entry).toMatchObject({
        id: item,
        recipientPersonId: lone.member.personId,
        subjectRecordId: subject,
        reason: 'assignment',
        factKind: 'record',
      });
      expect(typeof entry?.['raisedAt']).toBe('string');

      const transport: Transport = async (path, body, bearer) =>
        await w.api.fetch(
          new Request(`http://api.test${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
            body,
          }),
        );
      const cli = createCli({ transport, businessKey: BUSINESS_KEY, credential: opalToken });
      const answered = await cli.run('inbox.unattended', {});
      expect(answered.status).toBe(200);
      expect(answered.body).toStrictEqual({ ok: true, unattended: await unattended(opalToken) });
    });

    it('no agent reaches it, and it asks operations:read', () => {
      const row = COMMAND_SURFACE.find((c) => (c.name as string) === 'inbox.unattended');
      expect(row).toMatchObject({
        kind: 'read',
        collection: 'operations',
        action: 'read',
        agent: 'never',
      });
    });
  });

  describe('INB-1 isolation (the unattended read)', () => {
    it('person to person: a member without operations:read is refused, never shown an empty list', async () => {
      const answer = await call('inbox.unattended', pimToken);
      expect(answer.status).not.toBe(200);
      expect(answer.body['code']).toBe('SCOPE_NOT_GRANTED');
    });

    it('client to client: an operator reading only client A lists A and never B', async () => {
      const onA = await task('client A work', CLIENT_A);
      const onB = await task('client B work', CLIENT_B);
      const ann = await onTask('Ann A', onA, ['read']);
      const ben = await onTask('Ben B', onB, ['read']);
      const aItem = await raise(ann.member.personId, onA, 'mention');
      const bItem = await raise(ben.member.personId, onB, 'mention');
      await deactivate(ann.member, 'login');
      await deactivate(ben.member, 'login');
      const forOtto = await listed(ottoToken);
      expect(forOtto).toContain(aItem);
      expect(forOtto).not.toContain(bItem);
      const forOpal = await listed(opalToken);
      expect(forOpal).toContain(aItem);
      expect(forOpal).toContain(bItem);
    });

    it('business to business: neither operator lists the other business, nor reads it by its own key', async () => {
      const bravoTask = String(
        ok(
          await call(
            'task.create',
            brunoToken,
            {
              operationId: randomUUID(),
              fields: { title: 'bravo work' },
            },
            'bravo',
          ),
        ).body['recordId'],
      );
      const bravoItem = await raise(w.bravoPerson, bravoTask, 'mention', randomUUID(), w.bravo);
      const bravoList = (await unattended(brunoToken, 'bravo')).map((e) => String(e['id']));
      expect(bravoList).toStrictEqual([bravoItem]);
      expect(await listed(opalToken)).not.toContain(bravoItem);
      for (const id of await listed(opalToken)) expect(bravoList).not.toContain(id);
      expect((await call('inbox.unattended', brunoToken)).status).not.toBe(200);
      expect((await call('inbox.unattended', opalToken, {}, 'bravo')).status).not.toBe(200);
    });
  });
});
