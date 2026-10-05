// SPDX-License-Identifier: AGPL-3.0-only
//
// C71-D's conversations migration on a business installed before it, with a
// comment already written, and its data statements run a second time.

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
/** The team conversations migration's UTC timestamp ID (ORCH69-MIGTS). */
const CONVERSATIONS = '20261005004230';
const BEFORE = ALL.filter((m) => m.version < CONVERSATIONS);
const CONVERSATIONS_MIGRATION = ALL.find((m) => m.version.startsWith(CONVERSATIONS));

/** A business installed before the conversations migration, with a comment already written. */
interface World {
  readonly db: EmptyDatabase;
  readonly alpha: string;
  readonly ada: string;
  readonly mia: string;
  readonly adaActor: string;
  readonly taskComment: string;
}

async function shape({ db, alpha }: Pick<World, 'db' | 'alpha'>): Promise<string> {
  return JSON.stringify(
    await db.admin.execute(
      `select t.key, f.key as field, f.slot, f.visibility_class
         from public.record_types t
         left join public.field_defs f on f.business_id = t.business_id and f.record_type_id = t.id
        where t.business_id = $1 and t.key in ('team_conversation', 'task_comment')
        order by 1, 2`,
      [alpha],
    ),
  );
}

async function installedPair(
  db: EmptyDatabase,
): Promise<Pick<World, 'alpha' | 'ada' | 'mia' | 'adaActor'>> {
  const alpha = await insertBusiness(db.app, 'alpha');
  return await db.app.withBusiness(alpha, async (tx) => {
    const ada = await insertPerson(tx, 'Ada');
    const adaActor = await insertActor(tx, ada);
    await insertMembership(tx, ada);
    const mia = await insertPerson(tx, 'Mia');
    await insertActor(tx, mia);
    await insertMembership(tx, mia);
    await installTaskSpine(tx);
    return { alpha, ada, mia, adaActor };
  });
}

/**
 * Stand where a business installed before the conversations migration stands: no conversation type
 * and no `conversation` field on the comment type.
 */
async function removeConversationType(db: EmptyDatabase, alpha: string): Promise<void> {
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
}

async function commentBeforeConversations(
  db: EmptyDatabase,
  alpha: string,
  adaActor: string,
): Promise<string> {
  const [comment] = await db.admin.execute<{ readonly id: string }>(
    `select id from public.record_types where business_id = $1 and key = 'task_comment'`,
    [alpha],
  );
  return await db.app.withBusiness(alpha, async (tx) => {
    const [task] = await tx.query<{ readonly id: string }>(
      `select r.id from public.records r join public.record_types t
          on t.business_id = r.business_id and t.id = r.record_type_id
        where r.business_id = $1 and t.key = 'task_state' limit 1`,
      [alpha],
    );
    return await writeComment(tx, String(comment?.id), {
      taskId: String(task?.id),
      authorActorId: adaActor,
      commentType: 'note',
      audience: 'internal',
      body: 'written before the conversations migration',
      source: 'app',
    });
  });
}

async function installedBeforeConversations(): Promise<World> {
  const db = await createEmptyDatabase({ part: 'solc71a' });
  await applyMigrations(db.admin, BEFORE);
  const pair = await installedPair(db);
  await removeConversationType(db, pair.alpha);
  const taskComment = await commentBeforeConversations(db, pair.alpha, pair.adaActor);
  return { db, ...pair, taskComment };
}

/** Every statement of the conversations migration but the DDL, again. */
async function rerunData(db: EmptyDatabase): Promise<void> {
  for (const statement of CONVERSATIONS_MIGRATION?.statements ?? []) {
    if (/^\s*(create|alter|grant)\b/iu.test(statement.replace(/^(--[^\n]*\n|\s)*/u, ''))) {
      continue;
    }
    await db.admin.execute(statement);
  }
}

async function installsOnceAndKeeps(world: World): Promise<void> {
  const { db, alpha, ada, mia, adaActor } = world;
  await db.closeSessions();
  await applyMigrations(db.admin, ALL);
  const after = await shape(world);
  expect(after).toContain('"key":"team_conversation","field":"chat_pair","slot":"txt_3"');
  expect(after).toContain('"key":"task_comment","field":"conversation","slot":"uuid_4"');
  const [kept] = await db.admin.execute<{ readonly body: string }>(
    `select data ->> 'body' as body from public.records where id = $1`,
    [world.taskComment],
  );
  expect(kept?.body).toBe('written before the conversations migration');
  await rerunData(db);
  expect(await shape(world)).toBe(after);
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
      body: 'after the conversations migration',
      source: 'app',
    });
    const read = await readConversation(tx, types, id, mia);
    expect(read?.messages.map((m) => m.body)).toEqual(['after the conversations migration']);
  });
  expect(await shape(world)).toBe(after);
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'the conversations migration on an installed business',
  () => {
    let world: World;

    beforeAll(async () => {
      world = await installedBeforeConversations();
    }, 300_000);

    afterAll(async () => {
      await world?.db.drop();
    });

    it('the conversations migration installs the conversation type once on an installed business, keeps its comments, and its data statements are stable on a second run', async () => {
      await installsOnceAndKeeps(world);
    }, 300_000);
  },
);
