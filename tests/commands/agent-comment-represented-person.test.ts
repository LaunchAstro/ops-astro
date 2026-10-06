// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #414: an agent's comment records the person its delegation acted
// for, from that delegation and never the payload (the wire refuses an
// undeclared field), and an agent edit or delete must match that person as
// well as its own actor. The first case is the review's proof (OW-036.1),
// renamed for what it proves and otherwise as written. The second holds the
// two consequences the fix chose: what is stored, and an agent comment stored
// before the person was recorded is no agent's to edit.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { mintDelegation } from '../../packages/core-records/src/index.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { aiWorld, created, type AiWorld } from './ai-assign-world.ts';
import { codeOf } from './agent-fixture.ts';

let w: AiWorld;
beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) throw new Error('This proof requires Postgres.');
  w = await aiWorld('comment_represented_person');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

async function credentialFor(person: AiWorld['p'], taskId: string): Promise<string> {
  return await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    const result = await mintDelegation(tx, {
      agentActorId: w.world.agentActorId,
      delegatePersonId: person.personId,
      mintedByActorId: person.actorId,
      purpose: `author_${randomUUID().slice(0, 8)}`,
      collections: ['task'],
      actions: ['read', 'write', 'comment'],
      purposeScope: { kind: 'record', id: taskId },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!result.ok) throw new Error(`Mint refused ${result.refusal.code}`);
    return result.value.credential;
  });
}

// oxlint-disable-next-line max-lines-per-function -- the review's proof, kept as written
it('person to person: one agent actor acting for Q cannot edit or delete the comment it wrote for P', async () => {
  const taskId = await created(w, w.p, 'A task both people may comment on');
  const forP = await credentialFor(w.p, taskId);
  const forQ = await credentialFor(w.q, taskId);
  expect(w.p.personId).not.toBe(w.q.personId);
  const post = async (credential: string, body: string) => {
    const result = await w.world.asAgent(
      {
        command: 'task.comment',
        operationId: randomUUID(),
        recordId: taskId,
        body,
        audience: 'internal',
      },
      credential,
    );
    if (isCommandRefusal(result)) throw new Error(`Comment refused ${result.code}`);
    const detail = result.detail;
    if (
      typeof detail !== 'object' ||
      detail === null ||
      !('commentId' in detail) ||
      typeof detail['commentId'] !== 'string'
    )
      throw new Error('No comment id returned.');
    return detail['commentId'];
  };
  const pComment = await post(forP, 'P controls these words');
  await post(forQ, 'Q controls their own words');
  // Both credentials are live and independently permitted to comment on the
  // same task; only the represented person differs at the edit boundary.
  const own = await w.world.asAgent(
    {
      command: 'task.edit_comment',
      operationId: randomUUID(),
      recordId: taskId,
      commentId: pComment,
      body: 'P corrected their own words',
    },
    forP,
  );
  expect(codeOf(own)).toBe('not-a-refusal');
  const crossed = await w.world.asAgent(
    {
      command: 'task.edit_comment',
      operationId: randomUUID(),
      recordId: taskId,
      commentId: pComment,
      body: 'Q overwrote P',
    },
    forQ,
  );
  const removed = await w.world.asAgent(
    {
      command: 'task.delete_comment',
      operationId: randomUUID(),
      recordId: taskId,
      commentId: pComment,
    },
    forQ,
  );
  const [row] = await w.world.db.admin.execute<{ body: string; deleted: boolean }>(
    `select data ->> 'body' as body, deleted_at is not null as deleted from records where id = $1`,
    [pComment],
  );
  expect({
    edit: codeOf(crossed),
    remove: codeOf(removed),
    body: row?.body,
    deleted: row?.deleted,
  }).toStrictEqual({
    edit: 'SCOPE_NOT_GRANTED',
    remove: 'SCOPE_NOT_GRANTED',
    body: 'P corrected their own words',
    deleted: false,
  });
});

it('stores the delegating person on an agent comment, and an unrecorded one is refused to that person too', async () => {
  const taskId = await created(w, w.p, 'A task the agent comments on for P');
  const forP = await credentialFor(w.p, taskId);
  const posted = await w.world.asAgent(
    {
      command: 'task.comment',
      operationId: randomUUID(),
      recordId: taskId,
      body: 'Written for P',
      audience: 'internal',
    },
    forP,
  );
  if (isCommandRefusal(posted)) throw new Error(`Comment refused ${posted.code}`);
  const commentId = (posted.detail as { readonly commentId: string }).commentId;
  const stored = async () =>
    await w.world.db.admin.execute<{ person: string | null; body: string; deleted: boolean }>(
      `select data ->> 'on_behalf_of' as person, data ->> 'body' as body,
              deleted_at is not null as deleted
         from records where id = $1`,
      [commentId],
    );
  expect((await stored())[0]?.person).toBe(w.p.personId);

  // As the row stood before the person was recorded.
  await w.world.db.admin.execute(`update records set data = data - 'on_behalf_of' where id = $1`, [
    commentId,
  ]);
  const edit = await w.world.asAgent(
    {
      command: 'task.edit_comment',
      operationId: randomUUID(),
      recordId: taskId,
      commentId,
      body: 'Rewritten without a person on record',
    },
    forP,
  );
  const remove = await w.world.asAgent(
    { command: 'task.delete_comment', operationId: randomUUID(), recordId: taskId, commentId },
    forP,
  );
  expect({ edit: codeOf(edit), remove: codeOf(remove), row: (await stored())[0] }).toStrictEqual({
    edit: 'SCOPE_NOT_GRANTED',
    remove: 'SCOPE_NOT_GRANTED',
    row: { person: null, body: 'Written for P', deleted: false },
  });
});
