// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-5's server step against a real database, part two: the Answered, owed
// and Not acknowledged signals derived at read (a reply to a client message
// answers it, R42), the three isolation crossings for the new commands, an @
// that notifies nobody and carries its words nowhere but the comment, and the
// thread at three detail levels in one query each (CS-15.19).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { readTaskSpine } from '../../packages/core-commands/src/commands/context.ts';
import {
  readConversation,
  type ConversationLevel,
  type ConversationRead,
} from '../../packages/core-commands/src/reads/task-conversation.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import { enrol } from './fixture.ts';
import { codeOf } from './agent-fixture.ts';
import {
  clientA,
  commentIdOf,
  edit,
  ids,
  must,
  post,
  recordOf,
  remove,
  seedConversation,
  stored,
  task,
  thread,
  who,
  type Body,
  type Row,
} from './conversation-support.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'task-conversation-signals: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

beforeAll(async () => {
  if (serverUrl !== undefined) await seedConversation('tcs');
}, 240_000);

afterAll(async () => {
  await who.world?.drop();
});

const unchanged = (body: string) => ({ body, edited: false, deleted: false });

/** A comment the agent writes on its own task, by id. */
const agentComment = async (taskId: string, credential: string): Promise<string> => {
  const answer = (await who.world.asAgent(
    {
      command: 'task.comment',
      operationId: randomUUID(),
      recordId: taskId,
      body: 'the agent’s note',
      audience: 'internal',
    },
    credential,
  )) as { readonly detail?: Row };
  return String(answer.detail?.['commentId']);
};

const bodies = (read: ConversationRead): readonly unknown[] =>
  (read.messages ?? []).map((row) => row['body']);

/** The conversation at one level, and how many statements it took. */
const levelOf = async (
  tx: TenantQuery,
  recordId: string,
  level: ConversationLevel,
  internal: boolean,
): Promise<{ readonly read: ConversationRead; readonly queries: number }> => {
  const spine = await readTaskSpine(tx);
  let queries = 0;
  const counted = new Proxy(tx, {
    get(target, key, receiver) {
      if (key !== 'query') return Reflect.get(target, key, receiver) as unknown;
      return async (...args: Parameters<TenantQuery['query']>) => {
        queries += 1;
        return await target.query(...args);
      };
    },
  });
  const read = await readConversation(counted, spine.taskCommentTypeId, recordId, level, internal);
  return { read, queries };
};

describe.skipIf(serverUrl === undefined)('MP-4-5 signals', () => {
  it('MP-4-5 signals: a client question is owed, a team message not acknowledged, until answered', async () => {
    const recordId = ids['a'] ?? '';
    const question = commentIdOf(
      await post(who.clientPerson, recordId, 'client', 'when is it done?'),
    );
    const update = commentIdOf(await post(who.decider, recordId, 'client', 'it is on its way'));
    const note = commentIdOf(await post(who.decider, recordId, 'internal', 'team only'));
    const signal = async (id: string) =>
      (await thread(who.decider, recordId)).find((row) => row['id'] === id)?.['signal'];
    expect(await signal(question)).toBe('owed');
    expect(await signal(update)).toBe('not_acknowledged');
    expect(await signal(note)).toBeNull();

    // The client's own reply does not answer the client's own question.
    await post(who.clientPerson, recordId, 'client', 'any news?', question);
    expect(await signal(question)).toBe('owed');
    await post(who.clientPerson, recordId, 'client', 'thanks', update);
    expect(await signal(update)).toBe('answered');
  });

  it('MP-4-5 reply clears owed: a team reply to a client message answers it', async () => {
    const recordId = ids['a'] ?? '';
    const question = commentIdOf(await post(who.clientPerson, recordId, 'client', 'can you call?'));
    const signal = async () =>
      (await thread(who.decider, recordId)).find((row) => row['id'] === question)?.['signal'];
    expect(await signal()).toBe('owed');
    // A general message on the Client tab is not an answer (XC D9).
    await post(who.decider, recordId, 'client', 'a general update');
    expect(await signal()).toBe('owed');
    await post(who.colleague, recordId, 'client', 'calling at three', question);
    expect(await signal()).toBe('answered');
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-5 isolation', () => {
  it('MP-4-5 isolation: another business’s comment is not reached from this one', async () => {
    const bravo = who.bravo;
    const bravoTask = recordOf(
      await must(who.bravoAdmin, { command: 'task.create', fields: { title: 'bravo' } }, bravo),
    );
    const bravoWords = `bravo-words-${randomUUID()}`;
    const bravoComment = commentIdOf(
      await post(who.bravoAdmin, bravoTask, 'internal', bravoWords, undefined, bravo),
    );
    for (const answer of [
      await edit(who.decider, ids['a'] ?? '', bravoComment, 'reached'),
      await remove(who.decider, ids['a'] ?? '', bravoComment),
      await post(who.decider, ids['a'] ?? '', 'internal', 'reply', bravoComment),
    ]) {
      expect(isCommandRefusal(answer)).toBe(true);
      expect(JSON.stringify(answer)).not.toContain(bravoWords);
    }
    expect(await stored(bravoComment)).toStrictEqual(unchanged(bravoWords));
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-5 isolation, another client', () => {
  it('MP-4-5 isolation: another client’s comment is not reached through this client’s task', async () => {
    const otherWords = `client-b-words-${randomUUID()}`;
    const onB = commentIdOf(await post(who.decider, ids['b'] ?? '', 'client', otherWords));
    expect(codeOf(await edit(who.decider, ids['a'] ?? '', onB, 'moved'))).toBe('NOT_FOUND');
    expect(codeOf(await remove(who.decider, ids['a'] ?? '', onB))).toBe('NOT_FOUND');
    const across = await post(who.clientPerson, ids['a'] ?? '', 'client', 'reply', onB);
    expect(codeOf(across)).toBe('FIELD_VALUE_INVALID');
    expect(JSON.stringify(across)).not.toContain(otherWords);
    const onTaskB = await post(who.clientPerson, ids['b'] ?? '', 'client', 'reply', onB);
    expect(isCommandRefusal(onTaskB)).toBe(true);
    expect(JSON.stringify(onTaskB)).not.toContain(otherWords);
    expect(await stored(onB)).toStrictEqual(unchanged(otherWords));
  });
});

describe.skipIf(serverUrl === undefined)(
  'MP-4-5 isolation, an agent under a live delegation',
  () => {
    it('MP-4-5 isolation: an agent under a live delegation edits its own comment on its own task only', async () => {
      const own = commentIdOf(await post(who.decider, ids['a'] ?? '', 'internal', 'own'));
      const picked = await who.world.pickUp(who.decider, 'the agent’s task');
      const mine = await agentComment(picked.taskId, picked.credential);
      const personal = commentIdOf(
        await post(who.decider, picked.taskId, 'internal', 'the person’s'),
      );
      const byAgent = async (body: Body) =>
        await who.world.asAgent({ operationId: randomUUID(), ...body }, picked.credential);
      const rewrite = (commentId: string, body: string) =>
        byAgent({ command: 'task.edit_comment', recordId: picked.taskId, commentId, body });
      expect(isCommandRefusal(await rewrite(mine, 'the agent’s better note'))).toBe(false);
      expect((await stored(mine))?.body).toBe('the agent’s better note');
      expect(codeOf(await rewrite(personal, 'rewritten'))).toBe('SCOPE_NOT_GRANTED');
      const elsewhere = await byAgent({
        command: 'task.delete_comment',
        recordId: ids['a'],
        commentId: own,
      });
      expect(isCommandRefusal(elsewhere)).toBe(true);
      expect(await stored(own)).toStrictEqual(unchanged('own'));
      expect(await stored(personal)).toStrictEqual(unchanged('the person’s'));
    });
  },
);

describe.skipIf(serverUrl === undefined)('MP-4-5 mention scope', () => {
  it('MP-4-5 mention scope: an @ naming a person with no grant notifies nobody; the words stay in the comment', async () => {
    const outsider = await enrol(who.world.db.app, who.world.business, 'no-grant');
    const words = `mention-canary-${randomUUID()}`;
    const answer = await post(who.decider, ids['a'] ?? '', 'internal', `@no-grant ${words}`);
    const commentId = commentIdOf(answer);
    // Every row in the database that holds the words, table by table.
    const tables = await who.world.db.admin.execute<{ readonly name: string }>(
      `select format('%I.%I', table_schema, table_name) as name
         from information_schema.tables
        where table_type = 'BASE TABLE' and table_schema in ('public', 'ops')`,
    );
    const holders: string[] = [];
    for (const { name } of tables) {
      // oxlint-disable-next-line no-await-in-loop
      const rows = await who.world.db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from ${name} t where t::text like $1`,
        [`%${words}%`],
      );
      if (Number(rows[0]?.n) > 0) holders.push(`${name}:${rows[0]?.n}`);
    }
    expect(holders).toStrictEqual(['public.records:1']);
    const rows = await who.world.db.admin.execute<{ readonly id: string }>(
      `select id::text as id from public.records where data::text like $1`,
      [`%${words}%`],
    );
    expect(rows.map((row) => row.id)).toStrictEqual([commentId]);
    // And the named person reads nothing of it.
    const theirs = await executeRead(who.world.db.app, who.world.business, outsider.presented, {
      read: 'task.read',
      recordId: ids['a'],
    });
    expect(JSON.stringify(theirs)).not.toContain(words);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-5 three detail levels', () => {
  it('MP-4-5 three detail levels: brief, standard and full, each one query', async () => {
    const recordId = await task(clientA, 'levels');
    const words = Array.from({ length: 23 }, (_, index) => `message ${index}`);
    for (const [index, words_] of words.entries()) {
      // oxlint-disable-next-line no-await-in-loop
      await post(who.decider, recordId, index % 2 === 0 ? 'internal' : 'client', words_);
    }
    const [brief, standard, full, outside] = await who.world.db.app.withBusiness(
      who.world.business,
      async (tx) => [
        await levelOf(tx, recordId, 'brief', true),
        await levelOf(tx, recordId, 'standard', true),
        await levelOf(tx, recordId, 'full', true),
        await levelOf(tx, recordId, 'full', false),
      ],
    );
    expect([brief, standard, full, outside].map((level) => level?.queries)).toStrictEqual([
      1, 1, 1, 1,
    ]);
    expect(brief?.read).toMatchObject({
      level: 'brief',
      counts: { internal: 12, client: 11 },
      last: { body: 'message 22' },
    });
    expect(brief?.read.messages).toBeUndefined();
    expect(bodies(standard?.read ?? { level: 'standard', counts: {} })).toStrictEqual(
      words.slice(-20),
    );
    expect(bodies(full?.read ?? { level: 'full', counts: {} })).toStrictEqual(words);
    // Outside the business: the client messages only, and no internal count.
    expect(outside?.read.counts).toStrictEqual({ client: 11 });
    expect(bodies(outside?.read ?? { level: 'full', counts: {} })).toStrictEqual(
      words.filter((_, index) => index % 2 === 1),
    );
  });
});
