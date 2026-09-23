// SPDX-License-Identifier: AGPL-3.0-only
//
// A read's target, checked by the read that has one (root ruling 3, I14-SEAM U1).
//
// Five reads name no record: `task.queue`, `person.list`, `preset.plan`,
// `settings.read` and `session.capabilities`. Each accepted a `recordId` and
// ignored it, which is the command path's old mistake on the read half: a body
// whose identifier the server quietly drops is a body the caller believes was
// honoured. They now refuse it `COMMAND_BODY_INVALID`, as an untargeted command
// does, and the positive own-business call is what proves no foreign effect.
// The two reads that do take an identifier keep it: `task.read` its
// `recordId`, `task.board` its `board`.
//
// And `task.board` with no `board` at all answered the list of tasks on no
// board, which is `board: null`'s answer given to a body that asked nothing.
// It is refused by the read's own operand check, `FIELD_VALUE_INVALID` by
// name, like `task.read` without a `recordId`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from './fixture.ts';
import { enrol, grantTo, installSpine, WHOLE_BUSINESS } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { pathOf, type CommandName } from '../../packages/core-records/src/commands/surface.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

type Command = Parameters<typeof executeCommand>[4];

/** The target-free reads and a valid body for each. */
const TARGET_FREE: readonly (readonly [CommandName, Record<string, unknown>])[] = [
  ['task.queue', {}],
  ['person.list', {}],
  ['preset.plan', { recordTypeKey: 'task', presetKey: 'boundary', fields: [] }],
  ['settings.read', {}],
  ['session.capabilities', {}],
];

describe.skipIf(serverUrl === undefined)('read targets at the request boundary', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let token: string;
  let ownTask: string;
  let ownBoard: string;
  let foreignTask: string;

  const read = async (name: CommandName, body: Record<string, unknown>): Promise<Answer> =>
    await post(api, `/api/b/${BUSINESS_KEY}${pathOf(name)}`, body, authorised(token));

  const lastAudit = async () => {
    const rows = await fixture.db.admin.execute<Record<string, unknown>>(
      `select command, outcome, refusal_code, subject_record_id from public.audit_events
        where business_id = $1 order by seq desc limit 1`,
      [fixture.business],
    );
    return rows[0];
  };

  const make = async (business: string, who: Parameters<typeof grantTo>[1], title: string) => {
    const made = await executeCommand(fixture.db.app, business, who.presented, 'api', {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title },
    } as Command);
    if (isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
    return made.recordId ?? '';
  };

  beforeAll(async () => {
    fixture = await createApiFixture('boundary_reads');
    api = fixture.compose();
    token = await tokenFor(fixture.member.presented.subject);
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await grantTo(tx, fixture.member, 'read', WHOLE_BUSINESS, false, 'person');
      await grantTo(tx, fixture.member, 'read', WHOLE_BUSINESS, false, 'settings');
      await grantTo(tx, fixture.member, 'manage', WHOLE_BUSINESS, false, 'task');
    });
    ownTask = await make(fixture.business, fixture.member, 'an own task');
    ownBoard = await make(fixture.business, fixture.member, 'an own board');

    const bravo = await insertBusiness(fixture.db.app, 'bravo');
    await installSpine(fixture.db.app, bravo);
    const bea = await enrol(fixture.db.app, bravo, 'bea');
    await fixture.db.app.withBusiness(bravo, async (tx) => {
      await grantTo(tx, bea, 'read');
      await grantTo(tx, bea, 'write');
    });
    foreignTask = await make(bravo, bea, 'a foreign task');
  }, 60_000);

  afterAll(async () => await fixture?.drop());

  describe.each(TARGET_FREE)('%s', (name, body) => {
    it('answers the positive own-business call', async () => {
      const answer = await read(name, body);
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      expect(answer.body['ok']).toBe(true);
      // The answer is alpha's: nothing of bravo's is in it.
      expect(JSON.stringify(answer.body)).not.toContain(foreignTask);
      expect(await lastAudit()).toMatchObject({ command: name, outcome: 'applied' });
    });

    it('refuses a recordId, own, foreign, fabricated or malformed, with one body', async () => {
      const answers = [];
      for (const recordId of [ownTask, foreignTask, randomUUID(), 'not-a-record', null]) {
        // eslint-disable-next-line no-await-in-loop -- one audit row at a time
        const answer = await read(name, { ...body, recordId });
        expect(answer.status).toBe(400);
        expect(answer.body).toMatchObject({
          refused: true,
          code: 'COMMAND_BODY_INVALID',
          names: ['recordId'],
        });
        // eslint-disable-next-line no-await-in-loop -- as above
        expect(await lastAudit()).toStrictEqual({
          command: name,
          outcome: 'refused',
          refusal_code: 'COMMAND_BODY_INVALID',
          subject_record_id: null,
        });
        answers.push(answer);
      }
      for (const answer of answers) expect(answer).toStrictEqual(answers[0]);
    });

    it('refuses any other target field the read does not take', async () => {
      const answer = await read(name, { ...body, board: ownBoard });
      expect(answer.body).toMatchObject({ code: 'COMMAND_BODY_INVALID', names: ['board'] });
    });
  });

  it('leaves task.read its recordId, and refuses a target it does not take', async () => {
    const own = await read('task.read', { recordId: ownTask });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(await lastAudit()).toMatchObject({ outcome: 'applied', subject_record_id: ownTask });
    const foreign = await read('task.read', { recordId: foreignTask });
    expect(foreign.body['code']).toBe('NOT_FOUND');
    const extra = await read('task.read', { recordId: ownTask, board: ownBoard });
    expect(extra.body).toMatchObject({ code: 'COMMAND_BODY_INVALID', names: ['board'] });
  });

  it('leaves task.board its board: an own board and null list, a foreign one is NOT_FOUND', async () => {
    const own = await read('task.board', { board: ownBoard });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    const none = await read('task.board', { board: null });
    expect(none.status, JSON.stringify(none.body)).toBe(200);
    expect(JSON.stringify(none.body)).toContain(ownTask);
    for (const board of [foreignTask, randomUUID(), 'not-a-board']) {
      // eslint-disable-next-line no-await-in-loop -- one at a time
      const answer = await read('task.board', { board });
      expect(answer.status).toBe(404);
      expect(answer.body['code']).toBe('NOT_FOUND');
    }
    const extra = await read('task.board', { board: null, recordId: ownTask });
    expect(extra.body).toMatchObject({ code: 'COMMAND_BODY_INVALID', names: ['recordId'] });
  });

  it('refuses task.board with no board, or a board that is neither a string nor null (U1)', async () => {
    for (const body of [{}, { board: 7 }, { board: true }, { board: {} }, { board: [ownBoard] }]) {
      // eslint-disable-next-line no-await-in-loop -- one audit row at a time
      const answer = await read('task.board', body);
      expect(answer.status, JSON.stringify(body)).toBe(422);
      expect(answer.body).toMatchObject({
        refused: true,
        code: 'FIELD_VALUE_INVALID',
        names: ['board'],
      });
      expect(answer.body['tasks']).toBeUndefined();
      // eslint-disable-next-line no-await-in-loop -- as above
      expect(await lastAudit()).toStrictEqual({
        command: 'task.board',
        outcome: 'refused',
        refusal_code: 'FIELD_VALUE_INVALID',
        subject_record_id: null,
      });
    }
  });
});
