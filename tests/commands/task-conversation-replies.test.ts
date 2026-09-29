// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-5's server step against a real database, part one: replies one level
// deep on a particular message (R42), authors editing and deleting their own
// messages and replies (CS-4.34), and each new command's refusal and audit
// read-back. Signals, isolation, mention scope and the detail levels are in
// `task-conversation-signals.test.ts`; what the conversation wrote before this
// step is in `task-conversation.test.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import { codeOf } from './agent-fixture.ts';
import {
  as,
  commentIdOf,
  edit,
  ids,
  post,
  remove,
  revision,
  seedConversation,
  stored,
  task,
  thread,
  who,
  clientA,
  type Answer,
  type Body,
} from './conversation-support.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'task-conversation-replies: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

beforeAll(async () => {
  if (serverUrl !== undefined) await seedConversation('tcr');
}, 240_000);

afterAll(async () => {
  await who.world?.drop();
});

describe.skipIf(serverUrl === undefined)('MP-4-5 replies', () => {
  it('MP-4-5 reply one level: a reply sits on its message; a reply to a reply is refused', async () => {
    const top = commentIdOf(await post(who.decider, ids['a'] ?? '', 'internal', 'top message'));
    const reply = commentIdOf(
      await post(who.colleague, ids['a'] ?? '', 'internal', 'a reply', top),
    );
    const rows = await thread(who.decider, ids['a'] ?? '');
    expect(rows.find((row) => row['id'] === reply)?.['parent']).toBe(top);
    expect(rows.find((row) => row['id'] === top)?.['parent']).toBeNull();

    const before = await who.world.commentsOn(ids['a'] ?? '');
    const deeper = await post(who.decider, ids['a'] ?? '', 'internal', 'too deep', reply);
    expect(codeOf(deeper)).toBe('FIELD_VALUE_INVALID');
    expect(JSON.stringify(deeper)).toContain('parentId');
    // A reply goes to its message's audience: a client reply to a team note
    // would hand the client the note's id.
    const crossed = await post(who.decider, ids['a'] ?? '', 'client', 'wrong audience', top);
    expect(codeOf(crossed)).toBe('FIELD_VALUE_INVALID');
    expect(JSON.stringify(crossed)).toContain('audience');
    const malformed = await post(who.decider, ids['a'] ?? '', 'internal', 'bad parent', 'nope');
    // A string that is not an identifier is the envelope's, as for every id.
    expect(codeOf(malformed)).toBe('NOT_FOUND');
    expect(await who.world.commentsOn(ids['a'] ?? '')).toBe(before);
  });

  it('MP-4-5 replies survive loading: replies on every message come back, not only the first', async () => {
    const recordId = await task(clientA, 'many replies');
    const tops: string[] = [];
    for (const words of ['first', 'second', 'third']) {
      // oxlint-disable-next-line no-await-in-loop
      tops.push(commentIdOf(await post(who.decider, recordId, 'internal', words)));
    }
    for (const top of tops) {
      // oxlint-disable-next-line no-await-in-loop
      await post(who.colleague, recordId, 'internal', `reply to ${top}`, top);
    }
    const rows = await thread(who.decider, recordId);
    for (const top of tops) {
      expect(rows.filter((row) => row['parent'] === top)).toHaveLength(1);
    }
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-5 reply one level, a note out of reach', () => {
  it('MP-4-5 reply one level: a note the caller cannot write in is answered as absent', async () => {
    const note = commentIdOf(await post(who.decider, ids['a'] ?? '', 'internal', 'team only'));
    const before = await who.world.commentsOn(ids['a'] ?? '');
    // One of the client's people, naming an internal note's id: told the
    // same as for an id that is not there, never that it is a note.
    const probe = await post(who.clientPerson, ids['a'] ?? '', 'client', 'reply', note);
    const absent = await post(who.clientPerson, ids['a'] ?? '', 'client', 'reply', randomUUID());
    expect(codeOf(probe)).toBe('FIELD_VALUE_INVALID');
    expect(JSON.stringify(probe)).toStrictEqual(JSON.stringify(absent));
    expect(await who.world.commentsOn(ids['a'] ?? '')).toBe(before);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-5 own rows only', () => {
  it('MP-4-5 own rows only: the author edits and deletes; a colleague is refused and changes nothing', async () => {
    const mine = commentIdOf(await post(who.decider, ids['a'] ?? '', 'internal', 'my words'));
    const reply = commentIdOf(
      await post(who.decider, ids['a'] ?? '', 'internal', 'my reply', mine),
    );

    const theirs = await edit(who.colleague, ids['a'] ?? '', mine, 'not yours');
    expect(codeOf(theirs)).toBe('SCOPE_NOT_GRANTED');
    expect(await stored(mine)).toStrictEqual({ body: 'my words', edited: false, deleted: false });
    const theirDelete = await remove(who.colleague, ids['a'] ?? '', reply);
    expect(codeOf(theirDelete)).toBe('SCOPE_NOT_GRANTED');
    expect((await stored(reply))?.deleted).toBe(false);

    expect(isCommandRefusal(await edit(who.decider, ids['a'] ?? '', mine, 'my better words'))).toBe(
      false,
    );
    expect(await stored(mine)).toStrictEqual({
      body: 'my better words',
      edited: true,
      deleted: false,
    });
    const empty = await edit(who.decider, ids['a'] ?? '', mine, '   ');
    expect(codeOf(empty)).toBe('FIELD_VALUE_INVALID');
    expect((await stored(mine))?.body).toBe('my better words');

    expect(isCommandRefusal(await remove(who.decider, ids['a'] ?? '', reply))).toBe(false);
    expect((await stored(reply))?.deleted).toBe(true);
    const rows = await thread(who.decider, ids['a'] ?? '');
    expect(rows.map((row) => row['id'])).not.toContain(reply);
    expect(rows.find((row) => row['id'] === mine)?.['edited_at']).toEqual(expect.any(String));
    // A deleted message is gone to its author too.
    expect(codeOf(await edit(who.decider, ids['a'] ?? '', reply, 'back again'))).toBe('NOT_FOUND');
  });
});

const ownOf = (rows: readonly Readonly<Record<string, unknown>>[], id: string): unknown =>
  rows.find((row) => row['id'] === id)?.['own'];

describe.skipIf(serverUrl === undefined)('MP-4-5 own rows only, on the read', () => {
  it('MP-4-5 own rows only: the read marks the reader’s own rows, and only theirs', async () => {
    const mine = commentIdOf(await post(who.decider, ids['a'] ?? '', 'internal', 'mine to edit'));
    const theirs = commentIdOf(
      await post(who.colleague, ids['a'] ?? '', 'internal', 'theirs', mine),
    );

    const forAuthor = await thread(who.decider, ids['a'] ?? '');
    expect(ownOf(forAuthor, mine)).toBe(true);
    expect(ownOf(forAuthor, theirs)).toBe(false);
    const forColleague = await thread(who.colleague, ids['a'] ?? '');
    expect(ownOf(forColleague, mine)).toBe(false);
    expect(ownOf(forColleague, theirs)).toBe(true);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-5 permissions and audit, edit and delete', () => {
  it('MP-4-5 task:comment refused: edit and delete without the grant write nothing', async () => {
    const mine = commentIdOf(await post(who.decider, ids['a'] ?? '', 'internal', 'kept as is'));
    expect(codeOf(await edit(who.reader, ids['a'] ?? '', mine, 'changed'))).toBe(
      'SCOPE_NOT_GRANTED',
    );
    expect(codeOf(await remove(who.reader, ids['a'] ?? '', mine))).toBe('SCOPE_NOT_GRANTED');
    expect(await stored(mine)).toStrictEqual({ body: 'kept as is', edited: false, deleted: false });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-5 audit read-back, edit and delete', () => {
  it('MP-4-5 audit read-back: a reply, an edit and a delete each join the audit chain as applied', async () => {
    const top = commentIdOf(await post(who.clientPerson, ids['a'] ?? '', 'client', 'a question'));
    const operations: string[] = [];
    const run = async (body: Body): Promise<Answer> => {
      const operationId = randomUUID();
      operations.push(operationId);
      return await as(who.decider, { operationId, ...body });
    };
    const reply = commentIdOf(
      await run({
        command: 'task.comment',
        recordId: ids['a'],
        expectedRevision: await revision(ids['a'] ?? ''),
        body: 'the answer',
        audience: 'client',
        parentId: top,
      }),
    );
    await run({
      command: 'task.edit_comment',
      recordId: ids['a'],
      expectedRevision: await revision(ids['a'] ?? ''),
      commentId: reply,
      body: 'the better answer',
    });
    await run({
      command: 'task.delete_comment',
      recordId: ids['a'],
      expectedRevision: await revision(ids['a'] ?? ''),
      commentId: reply,
    });
    for (const operationId of operations) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await who.world.auditFor(operationId)).toStrictEqual([
        { outcome: 'applied', code: null },
      ]);
    }
    const chain = await who.world.db.app.withBusiness(
      who.world.business,
      async (tx) => await verifyAuditChain(tx),
    );
    expect(chain.intact).toBe(true);
  });
});
