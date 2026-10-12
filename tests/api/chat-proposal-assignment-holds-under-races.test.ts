// SPDX-License-Identifier: AGPL-3.0-only
//
// A chat card's create and its assignment under races and lost answers, on a
// fresh Postgres through the server's composition root.
//
// The assignment is `task.assign` at the revision the create returned, so the
// task's row lock and that revision are what hold it: another writer at the
// same revision at the same moment is serialised on the row, one of the two
// lands and the other is refused VERSION_STALE, and neither write is lost.
// The holder takes the row lock on a connection of its own, the assignment
// goes through the API's pool and the other writer through a third
// connection, each seen waiting before the holder lets go.
//
// A lost answer is the same request sent again: the create replays its first
// answer, revision included, and the assignment under its one operation id
// replays too. The same operation id with another person in the body is
// refused OPERATION_ID_REUSED and the first assignment stands, which is why a
// retry must send the body it first sent. The stored rows, read as admin, are
// the oracle.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/index.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { proposalAssign, proposalCreate } from '../../packages/core-wire/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import type { Answer } from './fixture.ts';
import { conversationWorld, started, type ConversationWorld } from './aw-03-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Made {
  readonly messageId: string;
  readonly task: { readonly recordId: string; readonly revision: number };
}

// eslint-disable-next-line max-lines-per-function -- one world, each timing on it
describe.skipIf(serverUrl === undefined)('chat proposal assignment under races', () => {
  let w: ConversationWorld;

  const create = async (messageId: string, title: string, conversationId: string | null) => {
    const write = proposalCreate({ title, description: null }, messageId, conversationId);
    return await w.as(w.owner, 'task.create', { ...write.body, operationId: write.operationId });
  };

  const made = async (title: string, conversationId: string | null = null): Promise<Made> => {
    const messageId = randomUUID();
    const answer = await create(messageId, title, conversationId);
    expect(answer.status).toBe(200);
    const task = {
      recordId: String(answer.body['recordId']),
      revision: Number(answer.body['revision']),
    };
    return { messageId, task };
  };

  const assign = async (card: Made, to: string): Promise<Answer> => {
    const write = proposalAssign(card.messageId, card.task, to);
    return await w.as(w.owner, 'task.assign', {
      ...write.body,
      operationId: write.operationId,
      expectedRevision: write.expectedRevision,
    });
  };

  const stored = async (taskId: string) => {
    const [row] = await w.fixture.db.admin.execute<{
      readonly person: string | null;
      readonly title: string | null;
      readonly revision: number;
    }>(
      `select data->>'assignee' as person, data->>'title' as title, revision
         from public.records where id = $1`,
      [taskId],
    );
    return row;
  };

  async function waitingOnLocks(n: number): Promise<void> {
    for (let tries = 0; tries < 400; tries += 1) {
      // eslint-disable-next-line no-await-in-loop -- polling the server
      const found = await w.count(
        `select count(*) as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
        [],
      );
      if (found >= n) return;
      // eslint-disable-next-line no-await-in-loop
      await sleep(25);
    }
    throw new Error(`${String(n)} backends never waited on a lock`);
  }

  beforeAll(async () => {
    w = await conversationWorld('chat_assign_races');
    await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      await grantTo(tx, w.owner, 'read', undefined, false, 'person');
    });
  }, 120_000);

  afterAll(async () => {
    await w?.drop();
  });

  it('a create with the conversation as its origin answers the revision its assignment is made at', async () => {
    const conversationId = await started(w, w.owner, { body: 'We need the printer booked.' });
    const card = await made('Book the printer', conversationId);
    const answer = await assign(card, w.colleague.personId);
    expect(answer.status).toBe(200);
    expect((await stored(card.task.recordId))?.person).toBe(w.colleague.personId);
  });

  it('the assignment and another writer at the create’s revision, at once, on separate connections: one lands, the other is refused stale, nothing is lost', async () => {
    const { db, business } = w.fixture;
    const card = await made('Order toner');
    const holder = connect(db.appUrl, { source: 'runtime' });
    const other = connect(db.appUrl, { source: 'runtime' });
    let assigning: Promise<Answer> | undefined;
    let renaming: Promise<unknown> | undefined;
    try {
      await holder.withBusiness(business, async (tx) => {
        await tx.query(`select id from records where business_id = $1 and id = $2 for update`, [
          business,
          card.task.recordId,
        ]);
        assigning = assign(card, w.colleague.personId);
        await waitingOnLocks(1);
        renaming = executeCommand(other, business, w.owner.presented, 'api', {
          command: 'task.update',
          operationId: randomUUID(),
          recordId: card.task.recordId,
          expectedRevision: card.task.revision,
          fields: { title: 'Order toner and paper' },
        });
        await waitingOnLocks(2);
      });
      const assigned = (await assigning) as Answer;
      const renamed = (await renaming) as Record<string, unknown>;
      const assignLanded = assigned.status === 200;
      const renameLanded = !('code' in renamed);
      // Exactly one of the two writes at that revision lands.
      expect([assignLanded, renameLanded].filter(Boolean)).toHaveLength(1);
      if (!assignLanded) expect(assigned.body['code']).toBe('VERSION_STALE');
      if (!renameLanded) expect(renamed['code']).toBe('VERSION_STALE');
      const row = await stored(card.task.recordId);
      expect(Number(row?.revision)).toBe(card.task.revision + 1);
      expect(row?.person).toBe(assignLanded ? w.colleague.personId : null);
      expect(row?.title).toBe(renameLanded ? 'Order toner and paper' : 'Order toner');
    } finally {
      await assigning?.catch(() => null);
      await renaming?.catch(() => null);
      await Promise.allSettled([holder, other].map(async (one) => await one.close()));
    }
  });

  it('both answers lost, the click sent again: the create replays its first revision and the assignment replays, holder unchanged', async () => {
    const card = await made('Draft the newsletter');
    const first = await assign(card, w.colleague.personId);
    expect(first.status).toBe(200);
    const replayed = await create(card.messageId, 'Draft the newsletter', null);
    expect(replayed.status).toBe(200);
    expect(replayed.body['recordId']).toBe(card.task.recordId);
    expect(replayed.body['revision']).toBe(card.task.revision);
    const again = await assign(card, w.colleague.personId);
    expect(again.body).toStrictEqual(first.body);
    expect((await stored(card.task.recordId))?.person).toBe(w.colleague.personId);
  });

  it('the same assignment id with another person in the body is refused OPERATION_ID_REUSED, and the first assignment stands', async () => {
    const card = await made('Book the venue');
    expect((await assign(card, w.colleague.personId)).status).toBe(200);
    const retried = await assign(card, w.owner.personId);
    expect(retried.body['code']).toBe('OPERATION_ID_REUSED');
    expect((await stored(card.task.recordId))?.person).toBe(w.colleague.personId);
  });

  it('an assignee id in upper case names the same person, and a retry spelling it in lower case is another request', async () => {
    const card = await made('Call the printer');
    const upper = await assign(card, w.colleague.personId.toUpperCase());
    expect(upper.status).toBe(200);
    expect((await stored(card.task.recordId))?.person).toBe(w.colleague.personId);
    const lower = await assign(card, w.colleague.personId);
    expect(lower.body['code']).toBe('OPERATION_ID_REUSED');
  });
});
