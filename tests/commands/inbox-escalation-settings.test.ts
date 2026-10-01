// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1e: escalation parked and settings per channel (supporting checklist
// lines C20 and C36). The unattended read itself is `inbox-unattended.test.ts`.
//
// Escalation of an unanswered decision is parked (the owner, C33-1): with
// every decider cut off and time passed, nothing names a fallback person,
// raises an item, writes a grant or decides, and the item stays unattended.
// A notification setting is per channel, never per item: in-app is always on,
// a decision or an incident is never switched off or batched on any channel,
// and the email channel waits on AW-07b. The key is self-scoped
// `preference:write`: no grant is asked, and the setting is only ever the
// caller's own, so no person reaches another's (person to person). Business
// and client separation over the unattended list are the other file's.

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { raiseInboxItem, readUnattended } from '../../packages/core-records/src/index.ts';
import { COMMAND_SURFACE, pathOf, type CommandName } from '../../packages/core-wire/src/surface.ts';
import { enrol, grantTo, WHOLE_BUSINESS, type Member } from './fixture.ts';
import { authorised, BUSINESS_KEY, post, tokenFor, type Answer } from '../api/fixture.ts';
import { clearingWorld, ok } from './inbox-clearing-world.ts';

const serverUrl = databaseUrlFromEnvironment();

const route = (name: string): string => pathOf(name as CommandName);

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(serverUrl === undefined)('INB-1e escalation parked and settings', () => {
  const w = clearingWorld('i1es');
  let opal: Member;
  let opalToken = '';
  let pim: Member;
  let pimToken = '';

  const call = async (
    name: string,
    token: string,
    body: Readonly<Record<string, unknown>> = {},
  ): Promise<Answer> =>
    await post(w.api, `/api/b/${BUSINESS_KEY}${route(name)}`, body, authorised(token));
  const listed = async (): Promise<readonly string[]> =>
    (
      ok(await call('inbox.unattended', opalToken)).body['unattended'] as Record<string, unknown>[]
    ).map((entry) => String(entry['id']));
  const setChannel = async (
    token: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<Answer> =>
    await call('notifications.set_channel', token, { operationId: randomUUID(), ...body });
  const task = async (title: string): Promise<string> =>
    String(
      ok(await call('task.create', w.memberToken, { operationId: randomUUID(), fields: { title } }))
        .body['recordId'],
    );
  const raise = async (recipient: string, subject: string): Promise<string> =>
    await w.fixture.db.app.withBusiness(
      w.fixture.business,
      async (tx) =>
        await raiseInboxItem(tx, {
          recipientPersonId: recipient,
          subjectRecordId: subject,
          reason: 'mention',
          fact: { kind: 'record', id: randomUUID() },
        }),
    );
  const countOf = async (table: 'inbox_items' | 'grants'): Promise<number> =>
    Number(
      (
        await w.fixture.db.admin.execute<{ n: string }>(
          `select count(*)::text as n from public.${table} where business_id = $1`,
          [w.fixture.business],
        )
      )[0]?.n,
    );
  const itemCount = async (): Promise<number> => await countOf('inbox_items');
  const grantCount = async (): Promise<number> => await countOf('grants');

  beforeAll(async () => {
    opal = await enrol(w.fixture.db.app, w.fixture.business, 'Opal Operator');
    pim = await enrol(w.fixture.db.app, w.fixture.business, 'Pim Plain');
    await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      await grantTo(tx, opal, 'read');
      await grantTo(tx, opal, 'read', WHOLE_BUSINESS, false, 'operations');
      await grantTo(tx, pim, 'read');
    });
    opalToken = await tokenFor(opal.presented.subject);
    pimToken = await tokenFor(pim.presented.subject);
  }, 120_000);

  // eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
  describe('INB-1 escalation parked', () => {
    // eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
    it('an unanswered decision with nobody reachable stays unattended: no fallback person, no grant, no decision', async () => {
      const proposed = await w.proposed('nobody answers');
      const holders = w.holders();
      const onFact = await w.itemsOnFact(proposed.gateId);
      expect(onFact.map((row) => row.recipient)).toStrictEqual(holders);
      // Everyone the decision was raised to is cut off, and time passes.
      await w.fixture.db.admin.execute(
        `update public.person_logins set active = false, deactivated_at = now()
          where person_id = any($1::uuid[]) and active`,
        [holders],
      );
      try {
        await w.fixture.db.admin.execute(
          `update public.inbox_items set raised_at = now() - interval '30 days' where fact_id = $1`,
          [proposed.gateId],
        );
        await w.fixture.db.admin.execute(
          `update public.gates set expires_at = now() - interval '1 day' where id = $1`,
          [proposed.gateId],
        );
        const grantsBefore = await grantCount();
        const itemsBefore = await itemCount();
        const ids = (await w.itemsOnFact(proposed.gateId)).map((row) => row.recipient);
        const first = await listed();
        const second = await listed();
        expect(second).toStrictEqual(first);
        const onGate = await w.fixture.db.admin.execute<{ id: string }>(
          `select id from public.inbox_items where fact_id = $1`,
          [proposed.gateId],
        );
        for (const row of onGate) expect(first).toContain(row.id);
        // Nothing escalated: the same recipients, no new item for anybody, no
        // grant written, and the gate still pending with no decision.
        expect((await w.itemsOnFact(proposed.gateId)).map((row) => row.recipient)).toStrictEqual(
          ids,
        );
        expect(await itemCount()).toBe(itemsBefore);
        expect(await grantCount()).toBe(grantsBefore);
        expect(await w.gateState(proposed.gateId)).toStrictEqual({
          state: 'pending',
          decisions: 0,
        });
        expect(COMMAND_SURFACE.some((c) => /escalat/iu.test(c.name))).toBe(false);
      } finally {
        // Put the two deciders back for the settings cases below.
        await w.fixture.db.admin.execute(
          `update public.person_logins set active = true, deactivated_at = null
            where person_id = any($1::uuid[])`,
          [holders],
        );
      }
    });
  });

  // eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
  describe('INB-1 settings per channel', () => {
    it('in-app is always on: on is accepted, anything else is refused', async () => {
      const on = ok(await setChannel(pimToken, { channel: 'in_app', mode: 'on' }));
      expect(on.body['detail']).toStrictEqual({ channel: 'in_app', mode: 'on' });
      for (const mode of ['off', 'daily_batch', 'instant']) {
        // oxlint-disable-next-line no-await-in-loop
        const answer = await setChannel(pimToken, { channel: 'in_app', mode });
        expect(answer.body['code'], mode).toBe('FIELD_VALUE_INVALID');
        expect(answer.body['names']).toStrictEqual(['mode']);
      }
    });

    it('nobody switches off or delays a decision or an incident, on any channel', async () => {
      for (const channel of ['in_app', 'email']) {
        for (const category of ['decision', 'incident']) {
          for (const mode of ['off', 'daily_batch']) {
            // oxlint-disable-next-line no-await-in-loop
            const answer = await setChannel(w.reviewerToken, { channel, category, mode });
            expect(answer.body['code'], `${channel} ${category} ${mode}`).toBe(
              'FIELD_VALUE_INVALID',
            );
            expect(answer.body['names']).toStrictEqual(['category']);
          }
        }
      }
    });

    it('the email channel is declared and waits on AW-07b', async () => {
      const answer = await setChannel(pimToken, {
        channel: 'email',
        category: 'mention',
        mode: 'off',
      });
      expect(answer.body['code']).toBe('DEPENDENCY_NOT_LANDED');
      expect(answer.body['names']).toStrictEqual(['channel']);
    });

    it('a setting is per channel, never per item, and an unknown channel is refused', async () => {
      const item = await raise(pim.personId, await task('per item'));
      const perItem = await setChannel(pimToken, { channel: 'in_app', mode: 'on', itemId: item });
      expect(perItem.status).toBe(400);
      expect(perItem.body['code']).toBe('COMMAND_BODY_INVALID');
      const sms = await setChannel(pimToken, { channel: 'sms', mode: 'on' });
      expect(sms.body['code']).toBe('FIELD_VALUE_INVALID');
      expect(sms.body['names']).toStrictEqual(['channel']);
    });

    it('a refused setting leaves every item where it was', async () => {
      const proposed = await w.proposed('still owed');
      const before = await w.itemsOnFact(proposed.gateId);
      for (const channel of ['in_app', 'email']) {
        // oxlint-disable-next-line no-await-in-loop
        const answer = await setChannel(w.reviewerToken, {
          channel,
          category: 'decision',
          mode: 'off',
        });
        expect(answer.status, channel).toBe(422);
        expect(answer.body['code'], channel).toBe('FIELD_VALUE_INVALID');
        expect(answer.body['names'], channel).toStrictEqual(['category']);
      }
      expect(await w.itemsOnFact(proposed.gateId)).toStrictEqual(before);
      expect(before.every((row) => row.work_state === 'open')).toBe(true);
    });

    it('no grant is asked and no agent reaches it: the key is self-scoped preference:write', () => {
      const row = COMMAND_SURFACE.find((c) => (c.name as string) === 'notifications.set_channel');
      expect(row).toMatchObject({
        kind: 'write',
        collection: 'preference',
        action: 'write',
        authorisedOn: 'self',
        agent: 'never',
      });
    });
  });

  // eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
  describe('INB-1 isolation (the unattended read)', () => {
    // eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
    it('a client B item is excluded before the client A query returns rows', async () => {
      const clientA = randomUUID();
      const clientB = randomUUID();
      const operator = await enrol(w.fixture.db.app, w.fixture.business, 'Scoped Operator');
      const onA = await task('scoped read A');
      const onB = await task('scoped read B');
      await w.fixture.db.admin.execute(
        `update public.records set data = data || jsonb_build_object('client', $2::text)
          where id = $1`,
        [onA, clientA],
      );
      await w.fixture.db.admin.execute(
        `update public.records set data = data || jsonb_build_object('client', $2::text)
          where id = $1`,
        [onB, clientB],
      );
      const ann = await enrol(w.fixture.db.app, w.fixture.business, 'Ann Scope A');
      const ben = await enrol(w.fixture.db.app, w.fixture.business, 'Ben Scope B');
      await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
        await grantTo(tx, operator, 'read', WHOLE_BUSINESS, false, 'operations');
        await grantTo(tx, operator, 'read', { kind: 'party', id: clientA });
        await grantTo(tx, ann, 'read', { kind: 'record', id: onA });
        await grantTo(tx, ben, 'read', { kind: 'record', id: onB });
      });
      const aItem = await raise(ann.personId, onA);
      const bItem = await raise(ben.personId, onB);
      await w.fixture.db.admin.execute(
        `update public.person_logins set active = false, deactivated_at = now()
          where person_id = any($1::uuid[]) and active`,
        [[ann.personId, ben.personId]],
      );
      await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
        const scopedTx = {
          businessId: tx.businessId,
          async query<Row>(sql: string, parameters?: readonly unknown[]): Promise<readonly Row[]> {
            const rows = await tx.query<Row>(sql, parameters);
            if (sql.includes('from public.inbox_items i')) {
              expect(
                rows.some(
                  (row) =>
                    typeof row === 'object' && row !== null && 'id' in row && row.id === bItem,
                ),
              ).toBe(false);
            }
            return rows;
          },
        };
        const visible = await readUnattended(scopedTx, operator.personId);
        expect(visible.map((entry) => entry.id)).toContain(aItem);
        expect(visible.map((entry) => entry.id)).not.toContain(bItem);
      });
    });
  });
});
