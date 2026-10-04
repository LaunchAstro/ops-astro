// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #419: a refused mention names a staff member only to an author
// who is staff here too. The first case is the review's proof (OW-037.1),
// renamed for what it proves and otherwise as written; the second holds the
// other side, so hiding every name could not pass for the fix.

import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { grantTo, shareWithClient } from './fixture.ts';
import {
  alpha,
  as,
  clientA,
  db,
  outcomeOf,
  owner,
  person,
  revisionOf,
  setUp,
  taskFor,
  tearDown,
} from './duplicate-world.ts';

beforeAll(setUp, 180_000);
afterAll(tearDown);

it('person to person: an external commenter cannot discover an unrelated staff name through a refused mention', async () => {
  const canary = `private-staff-${randomUUID()}`;
  const hidden = await person(canary);
  const task = await taskFor(alpha, owner, 'client-visible task', clientA);
  const client = await shareWithClient(db.app, alpha, owner, task);
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, client, 'comment', { kind: 'record', id: task });
  });
  const directory = await executeRead(db.app, alpha, client.presented, { read: 'person.list' });
  expect(directory).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
  const shared = await executeRead(db.app, alpha, client.presented, {
    read: 'task.read',
    recordId: task,
  });
  expect(isCommandRefusal(shared)).toBe(false);
  expect(JSON.stringify(shared)).not.toContain(canary);
  const revision = await revisionOf(task);
  const never = randomUUID();
  const send = async (mentioned: string) =>
    await as(alpha, client, {
      command: 'task.comment',
      recordId: task,
      expectedRevision: revision,
      body: 'message',
      audience: 'client',
      mentions: [mentioned],
    });
  const nonexistent = await send(never);
  expect(outcomeOf(nonexistent)).toMatchObject({ code: 'MENTION_NOT_READABLE' });
  const sentId = hidden.personId.toUpperCase();
  const answer = await send(sentId);
  expect(outcomeOf(answer)).toMatchObject({ code: 'MENTION_NOT_READABLE' });
  // Both identities are outside this client's directory. Echo only what they
  // sent, rather than disclosing existence, stored letter case or staff name.
  expect(
    JSON.stringify(answer),
    'refused mention exposed an unrelated staff member to a client',
  ).not.toContain(canary);
  expect(JSON.stringify(answer)).toContain(sentId);
  const rows = await db.admin.execute<{ n: string }>(
    `select count(*)::text as n from public.records
      where business_id = $1 and data ->> 'task' = $2 and data ->> 'body' = 'message'`,
    [alpha, task],
  );
  expect(rows[0]?.n).toBe('0');
});

it('a staff author is still told which staff member cannot read the comment', async () => {
  const canary = `named-staff-${randomUUID()}`;
  const unread = await person(canary);
  const task = await taskFor(alpha, owner, 'team task', clientA);
  // Staff held to this one task, so no business-wide read names anyone.
  const author = await person('task-only-staff');
  await db.app.withBusiness(alpha, async (tx) => {
    for (const action of ['read', 'comment'] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await grantTo(tx, author, action, { kind: 'record', id: task });
    }
  });
  const answer = await as(alpha, author, {
    command: 'task.comment',
    recordId: task,
    expectedRevision: await revisionOf(task),
    body: 'note',
    audience: 'internal',
    mentions: [unread.personId],
  });
  expect(outcomeOf(answer)).toMatchObject({ code: 'MENTION_NOT_READABLE' });
  expect(JSON.stringify(answer)).toContain(canary);
});
