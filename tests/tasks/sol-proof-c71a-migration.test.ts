// SPDX-License-Identifier: AGPL-3.0-only
//
// Reviewer proof for C71-D (SL10-26), uncommitted: 0341 on a business
// installed before it, with a comment already written, and its data
// statements run a second time.

// oxlint-disable no-await-in-loop
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  directConversation,
  readConversation,
  readConversationTypes,
  writeComment,
} from '../../packages/core-records/src/index.ts';
import { installTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import {
  applyMigrations,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../support/fresh-database.ts';
import {
  insertActor,
  insertBusiness,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';

const ALL = readMigrations('migrations');
const BEFORE = ALL.filter((m) => m.version.slice(0, 4) < '0341');
const M0341 = ALL.find((m) => m.version.startsWith('0341'));

describe.skipIf(databaseUrlFromEnvironment() === undefined)('0341 on an installed business', () => {
  let db: EmptyDatabase;
  let alpha: string;
  let ada: string;
  let mia: string;
  let adaActor: string;
  let taskComment: string;

  const shape = async (): Promise<string> =>
    JSON.stringify(
      await db.admin.execute(
        `select t.key, f.key as field, f.slot, f.visibility_class
           from public.record_types t
           left join public.field_defs f on f.business_id = t.business_id and f.record_type_id = t.id
          where t.business_id = $1 and t.key in ('team_conversation', 'task_comment')
          order by 1, 2`,
        [alpha],
      ),
    );

  beforeAll(async () => {
    db = await createEmptyDatabase({ part: 'sol0341' });
    await applyMigrations(db.admin, BEFORE);
    alpha = await insertBusiness(db.app, 'alpha');
    await db.app.withBusiness(alpha, async (tx) => {
      ada = await insertPerson(tx, 'Ada');
      adaActor = await insertActor(tx, ada);
      await insertMembership(tx, ada);
      mia = await insertPerson(tx, 'Mia');
      await insertActor(tx, mia);
      await insertMembership(tx, mia);
      await installTaskSpine(tx);
    });
    // Stand where a business installed before 0341 stands: no conversation
    // type and no `conversation` field on the comment type.
    await db.admin.execute(
      `delete from public.field_defs f using public.record_types t
        where f.business_id = t.business_id and f.record_type_id = t.id and t.business_id = $1
          and (t.key = 'team_conversation' or (t.key = 'task_comment' and f.key = 'conversation'))`,
      [alpha],
    );
    await db.admin.execute(
      `delete from public.record_types where business_id = $1 and key = 'team_conversation'`,
      [alpha],
    );
    const [comment] = await db.admin.execute<{ readonly id: string }>(
      `select id from public.record_types where business_id = $1 and key = 'task_comment'`,
      [alpha],
    );
    await db.app.withBusiness(alpha, async (tx) => {
      const [task] = await tx.query<{ readonly id: string }>(
        `select r.id from public.records r join public.record_types t
            on t.business_id = r.business_id and t.id = r.record_type_id
          where r.business_id = $1 and t.key = 'task_state' limit 1`,
        [alpha],
      );
      taskComment = await writeComment(tx, String(comment?.id), {
        taskId: String(task?.id),
        authorActorId: adaActor,
        commentType: 'note',
        audience: 'internal',
        body: 'written before 0341',
        source: 'app',
      });
    });
  }, 300_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('Sol proof, criterion 5: 0341 installs the conversation type once on an installed business, keeps its comments, and its data statements are stable on a second run', async () => {
    await db.closeSessions();
    await applyMigrations(db.admin, ALL);
    const after = await shape();
    expect(after).toContain('"key":"team_conversation","field":"chat_pair","slot":"txt_3"');
    expect(after).toContain('"key":"task_comment","field":"conversation","slot":"uuid_4"');
    const [kept] = await db.admin.execute<{ readonly body: string }>(
      `select data ->> 'body' as body from public.records where id = $1`,
      [taskComment],
    );
    expect(kept?.body).toBe('written before 0341');
    // Every statement of 0341 but the DDL, again.
    for (const statement of M0341?.statements ?? []) {
      if (/^\s*(create|alter|grant)\b/iu.test(statement.replace(/^(--[^\n]*\n|\s)*/u, ''))) {
        continue;
      }
      await db.admin.execute(statement);
    }
    expect(await shape()).toBe(after);
    // The install after it is stable, and a direct message works.
    await db.app.withBusiness(alpha, async (tx) => {
      await installTaskSpine(tx);
      const types = await readConversationTypes(tx);
      if (types === undefined) throw new Error('no conversation types');
      const id = await directConversation(tx, types, ada, mia);
      await writeComment(tx, types.commentTypeId, {
        taskId: null,
        conversationId: id,
        authorActorId: adaActor,
        commentType: 'note',
        audience: 'direct',
        body: 'after 0341',
        source: 'app',
      });
      const read = await readConversation(tx, types, id, mia);
      expect(read?.messages.map((m) => m.body)).toEqual(['after 0341']);
    });
    expect(await shape()).toBe(after);
  }, 300_000);
});
