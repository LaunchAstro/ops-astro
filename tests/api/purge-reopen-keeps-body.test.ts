// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #485, OW-031.5: the purge locks the scoped task's row as it reads
// it, so a reopen that commits while the purge waits keeps the conversation's
// body. The case is the review's proof (sol/OW-031.md criterion 5), renamed for
// what it proves and otherwise as written; its world is the proof file's.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeConversation, writeWrapUp } from '../../packages/core-commands/src/index.ts';
import { connect, type Database, type TenantQuery } from '../../packages/core-records/src/index.ts';
import {
  conversationWorld,
  setConversationWindow,
  started,
  type ConversationWorld,
} from './aw-03-fixture.ts';
import { authorised, post, tokenFor } from './fixture.ts';
import { createControls, type Controls } from './controls-fixture.ts';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, the review's case on it
describe.skipIf(serverUrl === undefined)('the purge and a reopen of its task', () => {
  let w: ConversationWorld;
  let c: Controls;
  let second: Database;
  beforeAll(async () => {
    c = await createControls('purge_reopen');
    w = await conversationWorld(c);
    second = connect(w.fixture.db.appUrl);
    await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      await setConversationWindow(tx, 7);
      await grantTo(tx, w.owner, 'share');
    });
  }, 180_000);
  afterAll(async () => {
    await second?.close();
    await w?.drop();
  });
  const wrap = async (conversationId: string) =>
    await w.fixture.db.app.withBusiness(
      w.fixture.business,
      async (tx) => await writeWrapUp(tx, { conversationId, codeRevision: '4126931' }),
    );
  const task = async (title: string, conversationId?: string) => {
    const answer = await w.as(w.owner, 'task.create', {
      fields: { title },
      ...(conversationId === undefined ? {} : { conversationId }),
    });
    expect(answer.status).toBe(200);
    return String(answer.body['recordId']);
  };
  const messages = async (conversationId: string) =>
    await w.count(
      'select count(*) as n from public.conversation_messages where conversation_id = $1',
      [conversationId],
    );

  // eslint-disable-next-line max-lines-per-function -- the review's proof, kept as written
  it('a task reopened while the purge waits on it keeps the conversation body', async () => {
    const taskId = await task('reopen during purge');
    const conversationId = await started(w, w.owner, {
      scope: { kind: 'task', id: taskId },
      body: 'Work can resume',
    });
    const read = await w.as(w.owner, 'task.read', { recordId: taskId });
    const complete = await w.as(w.owner, 'task.complete', {
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: (read.body['task'] as { revision: number }).revision,
    });
    expect(complete.status).toBe(200);
    await w.fixture.db.admin.execute(
      "update public.records set data = jsonb_set(data, '{completed_at}', to_jsonb((now() - interval '8 days')::text)) where id = $1",
      [taskId],
    );
    await w.age(conversationId, 8);
    expect(await wrap(conversationId)).toMatchObject({ ok: true, written: true });
    const current = await w.as(w.owner, 'task.read', { recordId: taskId });
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const written = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const holding: Database = {
      log: second.log,
      close: async () => {},
      withBusiness: async (businessId, run) =>
        await second.withBusiness(businessId, async (tx) => {
          const result = await run(tx);
          ready();
          await held;
          return result;
        }),
    };
    const reopening = post(
      w.fixture.compose(undefined, undefined, holding),
      '/api/b/alpha/task/reopen',
      {
        operationId: randomUUID(),
        recordId: taskId,
        reason: 'work resumed',
        expectedRevision: (current.body['task'] as { revision: number }).revision,
      },
      authorised(await tokenFor(w.owner.presented.subject)),
    );
    await written;
    let workRead = false;
    let outcome;
    try {
      outcome = await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
        const scheduled: TenantQuery = {
          ...tx,
          query: async <Row>(
            sql: string,
            parameters?: readonly unknown[],
          ): Promise<readonly Row[]> => {
            const pending = tx.query<Row>(sql, parameters);
            if (!workRead && sql.includes('from records r') && sql.includes('completed_at')) {
              workRead = true;
              let stop = false;
              // Release the committed reopen after an unlocked read completes,
              // or after a corrected locking read is observed waiting. Thus the
              // unchanged proof also completes when the task read gains a lock.
              const waits = async () => {
                // eslint-disable-next-line no-unmodified-loop-condition -- the query race stops this poll
                while (!stop) {
                  // eslint-disable-next-line no-await-in-loop -- observe the locking query before releasing its blocker
                  const n = await w.count(
                    "select count(*) as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%from records r%'",
                    [],
                  );
                  if (n > 0) return;
                  // eslint-disable-next-line no-await-in-loop -- bound the database polling rate
                  await sleep(10);
                }
              };
              await Promise.race([pending, waits()]);
              stop = true;
              release();
              const answer = await reopening;
              expect(answer.status, JSON.stringify(answer.body)).toBe(200);
            }
            return await pending;
          },
        };
        return await purgeConversation(scheduled, { conversationId, operationId: randomUUID() });
      });
    } finally {
      release();
      await reopening;
    }
    expect(workRead).toBe(true);
    expect({ outcome, messages: await messages(conversationId) }).toMatchObject({
      outcome: { ok: false, code: 'WORK_OPEN' },
      messages: 1,
    });
  });
});
