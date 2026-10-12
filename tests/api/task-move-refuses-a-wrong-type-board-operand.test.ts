// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.move` takes its board and board section as identifiers or null. A
// value of another JSON type (a number, a flag, an object, a list) is the
// caller's mistake, so it answers a typed 4xx refusal through the real route,
// as a wrong-type operand does on every other command, and never a 500. The
// task keeps its place: nothing of a refused move is written.

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { authorised, createApiFixture, post, tokenFor, type ApiFixture } from './fixture.ts';

const WRONG_TYPES: readonly (readonly [string, Readonly<Record<string, unknown>>])[] = [
  ['a numeric board', { board: 42, boardSection: null }],
  ['a flag for a board', { board: true, boardSection: null }],
  ['an object for a board', { board: { id: randomUUID() }, boardSection: null }],
  ['a list for a board', { board: [randomUUID()], boardSection: null }],
  ['a numeric board section', { board: null, boardSection: 7 }],
  ['an object for a board section', { board: null, boardSection: { id: randomUUID() } }],
];

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'task.move refuses a wrong-type board operand with a typed refusal',
  () => {
    let fixture: ApiFixture;
    let api: Hono;
    let headers: Record<string, string>;
    let taskId: string;

    beforeAll(async () => {
      fixture = await createApiFixture('move_wrong_type');
      api = fixture.compose();
      headers = authorised(await tokenFor(fixture.member.presented.subject));
      const made = await post(
        api,
        '/api/b/alpha/task/create',
        { operationId: randomUUID(), fields: { title: 'A task to move' } },
        headers,
      );
      expect(made.status).toBe(200);
      taskId = String(made.body['recordId']);
    }, 90_000);

    afterAll(async () => {
      await fixture?.drop();
    });

    it.each(WRONG_TYPES)('refuses %s with a typed 4xx and moves nothing', async (_, operands) => {
      const answer = await post(
        api,
        '/api/b/alpha/task/move',
        { operationId: randomUUID(), recordId: taskId, expectedRevision: 1, ...operands },
        headers,
      );
      expect(answer.status, JSON.stringify(answer.body)).toBeGreaterThanOrEqual(400);
      expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(500);
      expect(answer.body).toMatchObject({ refused: true, code: 'FIELD_VALUE_INVALID' });
      const kept = await fixture.db.app.withBusiness(
        fixture.business,
        async (tx) =>
          await tx.query<{ readonly revision: number }>(
            `select revision::int as revision from public.records where id = $1`,
            [taskId],
          ),
      );
      expect(kept[0]?.revision).toBe(1);
    });
  },
);
