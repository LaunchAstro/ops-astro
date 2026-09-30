// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1: a mention of someone who cannot read the comment is refused, naming
// them, but only to a caller who could already see that person: staff, or a
// person on a client the caller reads. Anyone else is echoed back by the
// identifier as sent, under the same refusal, so a commenter cannot learn the
// name behind another client's person.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { insertActor, insertPerson } from '../identity/fixture.ts';
import { enrol, grantTo, type Member } from './fixture.ts';
import { ok } from './inbox-clearing-world.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from '../api/fixture.ts';

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(databaseUrlFromEnvironment() === undefined)('INB-1 mention refusal names', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let deciderToken: string;
  let commenter: Member;
  let commenterToken: string;
  let contactA: string;
  let contactB: string;
  const clientA = randomUUID();
  const clientB = randomUUID();

  const call = async (
    name: Parameters<typeof pathOf>[0],
    body: Readonly<Record<string, unknown>>,
    token: string,
  ): Promise<Answer> =>
    await post(
      api,
      `/api/b/${BUSINESS_KEY}${pathOf(name)}`,
      { operationId: randomUUID(), ...body },
      authorised(token),
    );

  const taskOnA = async (): Promise<{ id: string; rev: number }> => {
    const created = ok(await call('task.create', { fields: { title: 'on A' } }, deciderToken));
    const [set] = await fixture.db.admin.execute<{ revision: string }>(
      `update public.records set data = data || jsonb_build_object('client', $2::text)
        where id = $1 returning revision::text as revision`,
      [String(created.body['recordId']), clientA],
    );
    return { id: String(created.body['recordId']), rev: Number(set?.revision) };
  };

  const mention = async (person: string): Promise<Answer> => {
    const task = await taskOnA();
    // Comment is granted on the task itself; the commenter reads client A.
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      for (const action of ['write', 'comment'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        await grantTo(tx, commenter, action, { kind: 'record', id: task.id });
      }
    });
    return await call(
      'task.comment',
      {
        recordId: task.id,
        expectedRevision: task.rev,
        body: 'have a look',
        audience: 'internal',
        mentions: [person],
      },
      commenterToken,
    );
  };

  beforeAll(async () => {
    fixture = await createApiFixture('inb1names');
    api = fixture.compose();
    deciderToken = await tokenFor(fixture.member.presented.subject);
    commenter = await enrol(fixture.db.app, fixture.business, 'Carl Commenter');
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await grantTo(tx, commenter, 'read', { kind: 'party', id: clientA });
      // One outside contact on each client, neither a member.
      for (const [name, client] of [
        ['Alma Aside', clientA],
        ['Bianca Bside', clientB],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop
        const personId = await insertPerson(tx, name);
        // oxlint-disable-next-line no-await-in-loop
        await insertActor(tx, personId);
        // oxlint-disable-next-line no-await-in-loop
        await grantTo(tx, { ...commenter, personId }, 'read', { kind: 'party', id: client });
        if (client === clientA) contactA = personId;
        else contactB = personId;
      }
    });
    commenterToken = await tokenFor(commenter.presented.subject);
  }, 120_000);

  afterAll(async () => {
    await fixture?.drop();
  });

  it("an unreadable mention of another client's person is refused without revealing their name", async () => {
    const refused = await mention(contactB);
    expect(refused.status).toBe(422);
    expect(refused.body['code']).toBe('MENTION_NOT_READABLE');
    expect(JSON.stringify(refused.body)).not.toContain('Bianca');
    expect(JSON.stringify(refused.body['fixes'])).toContain(contactB);
  });

  it('an unreadable mention still names a person on a client the caller reads', async () => {
    const refused = await mention(contactA);
    expect(refused.body['code']).toBe('MENTION_NOT_READABLE');
    expect(JSON.stringify(refused.body['fixes'])).toContain('Alma Aside');
  });
});
