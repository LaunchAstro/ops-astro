// SPDX-License-Identifier: AGPL-3.0-only
//
// A chat card's new task is assigned by the existing `task.assign`, at the
// revision its create returned, under the reply's own operation id
// (`proposalAssign`), so it meets that command's checks and no others. Against
// Postgres through the server's composition root: the clicker, as `team.list`
// names them, holds the task once the click lands, and the same click again is
// the same answer; a person of
// another business and an id that names nobody are one NOT_FOUND, the task
// left as it was. The stored rows, read as admin, are the oracle.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  proposalAssign,
  proposalCreate,
  type TeamListResult,
} from '../../packages/core-wire/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { conversationWorld, type ConversationWorld } from './aw-03-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, the three assignments on it
describe.skipIf(serverUrl === undefined)('chat proposal assignee against Postgres', () => {
  let w: ConversationWorld;

  /** A card's create, as the click sends it, for a reply of its own. */
  const made = async (title: string) => {
    const messageId = randomUUID();
    const write = proposalCreate({ title, description: null }, messageId, null);
    const answer = await w.as(w.owner, 'task.create', {
      ...write.body,
      operationId: write.operationId,
    });
    expect(answer.status).toBe(200);
    const task = {
      recordId: String(answer.body['recordId']),
      revision: Number(answer.body['revision']),
    };
    return { messageId, task };
  };

  const assign = async (
    messageId: string,
    task: { recordId: string; revision: number },
    to: string,
  ) => {
    const write = proposalAssign(messageId, task, to);
    return await w.as(w.owner, 'task.assign', {
      ...write.body,
      operationId: write.operationId,
      expectedRevision: write.expectedRevision,
    });
  };

  const holderOf = async (taskId: string): Promise<string | null> => {
    const [row] = await w.fixture.db.admin.execute<{ readonly person: string | null }>(
      `select data->>'assignee' as person from public.records where id = $1`,
      [taskId],
    );
    return row?.person ?? null;
  };

  const team = async (): Promise<TeamListResult> =>
    (await w.as(w.owner, 'team.list', {})).body as unknown as TeamListResult;

  beforeAll(async () => {
    w = await conversationWorld('chat_assign');
    // The Team panel's read, as staff hold it.
    await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      await grantTo(tx, w.owner, 'read', undefined, false, 'person');
    });
  }, 120_000);

  afterAll(async () => {
    await w?.drop();
  });

  it('the clicker team.list names holds the new task, and the same click again is the same answer', async () => {
    const { you } = await team();
    expect(you).toBe(w.owner.personId);
    const { messageId, task } = await made('Book the printer');
    const first = await assign(messageId, task, you);
    const again = await assign(messageId, task, you);
    expect(first.status).toBe(200);
    expect(again.body).toStrictEqual(first.body);
    expect(await holderOf(task.recordId)).toBe(you);
  });

  it('a person of another business and an id of nobody are one NOT_FOUND, and the task stays unassigned', async () => {
    const elsewhere = await insertBusiness(
      w.fixture.db.app,
      `chat-assign-${randomUUID().slice(0, 8)}`,
    );
    const outsider = await enrol(w.fixture.db.app, elsewhere, 'outsider');
    const listed = JSON.stringify(await team());
    expect(listed).not.toContain(outsider.personId);
    const refusedTo = async (to: string) => {
      const { messageId, task } = await made(`Nobody holds this ${to}`);
      const answer = await assign(messageId, task, to);
      expect(await holderOf(task.recordId)).toBeNull();
      return { status: answer.status, body: answer.body };
    };
    const answers = [await refusedTo(outsider.personId), await refusedTo(randomUUID())];
    expect(answers[0]).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
    expect(answers[1]).toStrictEqual(answers[0]);
  });
});
