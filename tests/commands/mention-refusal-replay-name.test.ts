// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #419, Sol round 1 (PRV-oa-744-R1): the register keeps a refused
// mention naming each person only by the identifier as sent, so replaying the
// operation names nobody the author may no longer see. The case is the
// review's proof, renamed for what it proves and otherwise as written.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { grantTo, WHOLE_BUSINESS } from './fixture.ts';
import {
  alpha,
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

it('replaying a refused mention names no staff member once the author loses the people directory', async () => {
  const canary = `replay-private-staff-${randomUUID()}`;
  const unread = await person(canary);
  const author = await person('replay-directory-reader');
  const task = await taskFor(alpha, owner, 'mention replay task', clientA);
  const directoryGrant = await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, author, 'read', { kind: 'record', id: task });
    await grantTo(tx, author, 'comment', { kind: 'record', id: task });
    return await grantTo(tx, author, 'read', WHOLE_BUSINESS, false, 'person');
  });
  const request = {
    command: 'task.comment' as const,
    operationId: randomUUID(),
    recordId: task,
    expectedRevision: await revisionOf(task),
    body: 'private name must follow current access',
    audience: 'internal' as const,
    mentions: [unread.personId.toUpperCase()],
  };
  const first = await executeCommand(db.app, alpha, author.presented, 'api', request);
  expect(outcomeOf(first)).toMatchObject({ code: 'MENTION_NOT_READABLE' });
  expect(JSON.stringify(first)).toContain(canary);

  await db.app.withBusiness(alpha, async (tx) => {
    expect(await revokeGrant(tx, directoryGrant)).not.toBeNull();
  });
  const directory = await executeRead(db.app, alpha, author.presented, { read: 'person.list' });
  expect(directory).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
  const fresh = await executeCommand(db.app, alpha, author.presented, 'api', {
    ...request,
    operationId: randomUUID(),
  });
  expect(outcomeOf(fresh)).toMatchObject({ code: 'MENTION_NOT_READABLE' });
  expect(JSON.stringify(fresh)).not.toContain(canary);
  expect(JSON.stringify(fresh)).toContain(request.mentions[0]);

  const replay = await executeCommand(db.app, alpha, author.presented, 'api', request);
  expect(outcomeOf(replay)).toMatchObject({ code: 'MENTION_NOT_READABLE' });
  expect(
    JSON.stringify(replay),
    'replay disclosed a staff name after directory revocation',
  ).not.toContain(canary);
});
