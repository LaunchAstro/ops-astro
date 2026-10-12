// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1: a comment names at most 50 people, and whether each can
// read the task is asked in one statement inside the task lock, not one
// access walk per person.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { readMentions, type TenantQuery } from '../../packages/core-records/src/index.ts';
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

/** The most people one comment names (docs/local/API.md, `task.comment`). */
const MENTION_LIMIT = 50;

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(databaseUrlFromEnvironment() === undefined)('INB-1 mention limit', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let token: string;
  let reader: Member;
  let stranger: Member;

  const call = async (
    name: Parameters<typeof pathOf>[0],
    body: Readonly<Record<string, unknown>>,
  ): Promise<Answer> =>
    await post(
      api,
      `/api/b/${BUSINESS_KEY}${pathOf(name)}`,
      { operationId: randomUUID(), ...body },
      authorised(token),
    );

  const newTask = async (): Promise<{ id: string; rev: number }> => {
    const created = ok(await call('task.create', { fields: { title: 'mentions' } }));
    return { id: String(created.body['recordId']), rev: Number(created.body['revision']) };
  };

  const commentsOn = async (taskId: string): Promise<number> => {
    const [row] = await fixture.db.admin.execute<{ n: string }>(
      `select count(*)::text as n from public.records where business_id = $1 and data ->> 'task' = $2`,
      [fixture.business, taskId],
    );
    return Number(row?.n);
  };

  beforeAll(async () => {
    fixture = await createApiFixture('mentionlimit');
    api = fixture.compose();
    token = await tokenFor(fixture.member.presented.subject);
    reader = await enrol(fixture.db.app, fixture.business, 'Rita Reader');
    stranger = await enrol(fixture.db.app, fixture.business, 'Sam Stranger');
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await grantTo(tx, reader, 'read');
    });
  }, 120_000);

  afterAll(async () => {
    await fixture?.drop();
  });

  it('a comment naming more people than the mention limit is refused and writes nothing', async () => {
    const task = await newTask();
    const comment = async (count: number): Promise<Answer> =>
      await call('task.comment', {
        recordId: task.id,
        expectedRevision: task.rev,
        body: 'everyone look',
        audience: 'internal',
        mentions: Array.from({ length: count }, () => reader.personId),
      });

    const refused = await comment(MENTION_LIMIT + 1);
    expect(refused.status).toBe(422);
    expect(refused.body['code']).toBe('FIELD_VALUE_INVALID');
    expect(refused.body['names']).toEqual(['mentions']);
    expect(JSON.stringify(refused.body)).not.toContain(reader.personId);
    expect(await commentsOn(task.id)).toBe(0);

    ok(await comment(MENTION_LIMIT));
    expect(await commentsOn(task.id)).toBe(1);
  });

  it("a comment's mentions are checked for access in one statement", async () => {
    const task = await newTask();
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      // A client's contact, no membership, who reads this task: not a reader
      // of a team-only comment.
      const contact = await insertPerson(tx, 'Cleo Contact');
      await insertActor(tx, contact);
      await grantTo(tx, { ...reader, personId: contact }, 'read', { kind: 'record', id: task.id });

      const statements: string[] = [];
      const counted: TenantQuery = {
        businessId: tx.businessId,
        query: async (sql, parameters) => {
          statements.push(sql);
          return await tx.query(sql, parameters);
        },
      };
      const absent = randomUUID();
      const named = await readMentions(counted, { taskId: task.id, audience: 'internal' }, [
        reader.personId,
        stranger.personId,
        contact,
        absent,
      ]);

      expect(statements).toHaveLength(1);
      expect(named.map((person) => [person.personId, person.readable, person.member])).toEqual([
        [reader.personId, true, true],
        [stranger.personId, false, true],
        [contact, false, false],
        [absent, false, false],
      ]);
    });
  });
});
