// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { readAuthenticationAttempts } from '../../packages/core-records/src/identity/authentication-attempts.ts';
import { readAuditEvents } from '../../packages/core-commands/src/commands/audit.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { scopeWorld, scopeRead, type ScopeWorld } from './typed-todo-scope-world.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();
let w: ScopeWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await scopeWorld();
}, 180_000);
afterAll(async () => {
  await w?.db.drop();
});
async function ids(
  scope: Readonly<Record<string, unknown>> = {},
  by = w.owner,
): Promise<readonly string[]> {
  const answer = await scopeRead(w, { read: 'task.todos', ...scope }, by);
  if (isCommandRefusal(answer) || !('todos' in answer))
    throw new Error(`Expected typed scope to-dos ${JSON.stringify(answer)}`);
  return answer.todos.map((todo) => todo.id).toSorted();
}
it.skipIf(serverUrl === undefined)(
  'persisted teammate tasks absent from own read appear only in the admitted person/client intersection',
  async () => {
    expect(await ids()).toEqual([w.own]);
    expect(await ids({ person: w.teammate.personId })).toEqual([w.teamA, w.teamB].toSorted());
    expect(await ids({ client: w.clientA })).toEqual([w.own, w.teamA].toSorted());
    expect(await ids({ person: w.teammate.personId, client: w.clientA })).toEqual([w.teamA]);
    await w.db.closeSessions();
    expect(await ids({ person: w.teammate.personId, client: w.clientA })).toEqual([w.teamA]);
  },
);
it.skipIf(serverUrl === undefined)(
  'record-only reader is refused before any scoped list or count',
  async () => {
    const answer = await scopeRead(
      w,
      { read: 'task.todos', person: w.teammate.personId, client: w.clientA },
      w.limited,
    );
    expect(answer).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
    expect(answer).not.toHaveProperty('todos');
    expect(answer).not.toHaveProperty('count');
    expect(JSON.stringify(answer)).not.toContain('client B canary');
  },
);
it.skipIf(serverUrl === undefined)(
  'task:read alone never supplies or admits a person vocabulary',
  async () => {
    const listed = await scopeRead(w, { read: 'person.list' }, w.taskOnly);
    expect(listed).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
    const scoped = await scopeRead(
      w,
      { read: 'task.todos', person: w.teammate.personId },
      w.taskOnly,
    );
    expect(scoped).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
    expect(scoped).not.toHaveProperty('todos');
  },
);
it.skipIf(serverUrl === undefined)(
  'another business person and client tokens are the same not-found as fabricated tokens',
  async () => {
    const answers = await Promise.all(
      [
        { person: w.foreignOwner.personId },
        { client: w.foreignClient },
        { person: randomUUID() },
        { client: randomUUID() },
      ].map((scope) => scopeRead(w, { read: 'task.todos', ...scope })),
    );
    expect(answers[0]).toEqual(answers[2]);
    expect(answers[1]).toEqual(answers[3]);
    for (const answer of answers) {
      expect(answer).toMatchObject({ refused: true, code: 'NOT_FOUND' });
      expect(answer).not.toHaveProperty('todos');
      expect(JSON.stringify(answer)).not.toContain('canary');
    }
  },
);
it.skipIf(serverUrl === undefined)(
  'malformed identity scopes are refused instead of silently widened',
  async () => {
    const answer = await scopeRead(w, {
      read: 'task.todos',
      person: 'not-an-id',
      client: w.clientA,
    });
    expect(answer).toMatchObject({ refused: true, code: 'FIELD_VALUE_INVALID' });
    expect(answer).not.toHaveProperty('todos');
  },
);

it.skipIf(serverUrl === undefined)(
  'a former teammate cannot be admitted by a direct UUID scoped request',
  async () => {
    const former = await enrol(w.db.app, w.business, 'Former member');
    await w.db.app.withBusiness(w.business, async (tx) => {
      await tx.query(
        `update public.memberships set active = false, ended_at = now()
      where business_id = $1 and person_id = $2 and active`,
        [w.business, former.personId],
      );
    });
    expect(await scopeRead(w, { read: 'task.todos', person: former.personId })).toMatchObject({
      refused: true,
      code: 'NOT_FOUND',
    });
  },
);
it.skipIf(serverUrl === undefined)(
  'revoked person vocabulary is rechecked on every direct scoped request',
  async () => {
    const reader = await enrol(w.db.app, w.business, 'Revoked vocabulary reader');
    const grant = await w.db.app.withBusiness(w.business, async (tx) => {
      await grantTo(tx, reader, 'read');
      return await grantTo(tx, reader, 'read', undefined, false, 'person');
    });
    expect(await ids({ person: w.teammate.personId }, reader)).toEqual(
      [w.teamA, w.teamB].toSorted(),
    );
    await w.db.app.withBusiness(w.business, async (tx) => {
      await revokeGrant(tx, grant);
    });
    const answer = await scopeRead(w, { read: 'task.todos', person: w.teammate.personId }, reader);
    expect(answer).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
    expect(answer).not.toHaveProperty('todos');
  },
);

it.skipIf(serverUrl === undefined)(
  'checked scopes preserve read and authentication auditing without mutation events or effects',
  async () => {
    const events = () => w.db.app.withBusiness(w.business, (tx) => readAuditEvents(tx));
    const attempts = () =>
      w.db.app.withBusiness(w.business, (tx) => readAuthenticationAttempts(tx, w.owner.presented));
    const records = () =>
      w.db.app.withBusiness(w.business, (tx) =>
        tx.query(
          'select id, revision::text, data from public.records where business_id = $1 order by id',
          [w.business],
        ),
      );
    const before = await events();
    const authBefore = await attempts();
    const recordsBefore = await records();
    await scopeRead(w, { read: 'person.list' });
    await scopeRead(w, { read: 'client.list' });
    await scopeRead(w, { read: 'task.todos', person: w.teammate.personId, client: w.clientA });
    const after = await events();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(
      after.slice(before.length).map((event) => ({
        command: event.command,
        operationId: event.operation_id,
        outcome: event.outcome,
      })),
    ).toEqual([
      { command: 'person.list', operationId: null, outcome: 'applied' },
      { command: 'client.list', operationId: null, outcome: 'applied' },
      { command: 'task.todos', operationId: null, outcome: 'applied' },
    ]);
    expect(await attempts()).toHaveLength(authBefore.length + 3);
    expect(await records()).toEqual(recordsBefore);
  },
);
it.skipIf(serverUrl === undefined)(
  'revoking business task authority leaves only party client reach and refuses both task scopes without counts',
  async () => {
    const reader = await enrol(w.db.app, w.business, 'Revoked task reader');
    const grant = await w.db.app.withBusiness(w.business, async (tx) => {
      await grantTo(tx, reader, 'read', { kind: 'party', id: w.clientA });
      return await grantTo(tx, reader, 'read');
    });
    const before = await scopeRead(w, { read: 'client.list' }, reader);
    if (isCommandRefusal(before) || !('clients' in before))
      throw new Error('Expected reached clients');
    expect(before.clients.map((client) => clientIdOf(client)).toSorted()).toEqual(
      [w.clientA, w.clientB].toSorted(),
    );
    await w.db.app.withBusiness(w.business, async (tx) => {
      await revokeGrant(tx, grant);
    });
    const after = await scopeRead(w, { read: 'client.list' }, reader);
    if (isCommandRefusal(after) || !('clients' in after))
      throw new Error('Expected remaining party client');
    expect(after.clients.map((client) => clientIdOf(client))).toEqual([w.clientA]);
    const results = await Promise.all(
      [w.clientA, w.clientB].map((client) => scopeRead(w, { read: 'task.todos', client }, reader)),
    );
    for (const result of results) {
      expect(result).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
      expect(result).not.toHaveProperty('todos');
      expect(result).not.toHaveProperty('count');
      expect(JSON.stringify(result)).not.toContain('canary');
    }
  },
);

function clientIdOf(client: { readonly clientId: string } | object): string {
  if (!('clientId' in client) || typeof client.clientId !== 'string')
    throw new Error('Expected client.list identities');
  return client.clientId;
}
