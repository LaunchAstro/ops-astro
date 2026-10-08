// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { scopeWorld, scopeRead, type ScopeWorld } from './typed-todo-scope-world.ts';
import { BoardDestinations } from './board-destinations-world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { readAuditEvents } from '../../packages/core-commands/src/commands/audit.ts';
import { readAuthenticationAttempts } from '../../packages/core-records/src/identity/authentication-attempts.ts';
const serverUrl = databaseUrlFromEnvironment();
let w: ScopeWorld;
let d: BoardDestinations;
let pool: Awaited<ReturnType<BoardDestinations['seed']>>;
beforeAll(async () => {
  if (serverUrl !== undefined) {
    w = await scopeWorld();
    d = new BoardDestinations(w);
    pool = await d.seed();
  }
}, 180_000);
afterAll(async () => {
  await w?.db.drop();
});
const live = it.skipIf(serverUrl === undefined);
live(
  'plain selected unboarded and aggregate reads page only for actual paging operands',
  async () => {
    for (const destination of [
      { board: null },
      { board: pool.boardA },
      { mode: 'aggregate', person: w.teammate.personId },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- each full contract precedes the same destination's page.
      const plain = await scopeRead(w, { read: 'task.board', ...destination });
      expect(plain).toMatchObject({
        ok: true,
        viewer: w.owner.personId,
        owed: expect.any(Number),
        withheld: 0,
      });
      expect(plain).toHaveProperty('tasks');
      expect(plain).not.toHaveProperty('page');
      // eslint-disable-next-line no-await-in-loop -- explicit paging is the same admitted destination.
      const paged = await scopeRead(w, {
        read: 'task.board',
        ...destination,
        detail: 'brief',
        limit: 1,
      });
      expect(paged).toHaveProperty('page');
      expect(paged).not.toHaveProperty('tasks');
    }
  },
);
live('two boards and unboarded identity intersections retain scored canonical ranks', async () => {
  const ordinary = await d.read({ board: null });
  const unboardedId = pool.tasks[2];
  expect(ordinary.tasks.find((t) => t.id === unboardedId)?.rank.number).toEqual(expect.any(Number));
  for (const identity of [
    { person: w.teammate.personId },
    { client: w.clientA },
    { person: w.teammate.personId, client: w.clientA },
  ]) {
    // eslint-disable-next-line no-await-in-loop -- compare each semantic scope to the same reader pool.
    const answer = await d.read({ mode: 'aggregate', ...identity });
    expect(pool.tasks.every((id) => answer.tasks.some((t) => t.id === id))).toBe(true);
    expect(answer.tasks.find((t) => t.id === unboardedId)?.rank).toEqual(
      ordinary.tasks.find((t) => t.id === unboardedId)?.rank,
    );
  }
  expect((await d.read({ board: pool.boardA })).tasks.map((t) => t.id)).toEqual([pool.tasks[0]]);
  expect((await d.read({ board: pool.boardB })).tasks.map((t) => t.id)).toEqual([pool.tasks[1]]);
  expect(ordinary.tasks.map((t) => t.id)).not.toContain(pool.tasks[0]);
  const own = await d.read({ mode: 'aggregate' });
  expect(own.tasks.map((t) => t.id)).toContain(w.own);
  expect(own.tasks.map((t) => t.id)).not.toContain(w.teamA);
});
live(
  'aggregate excludes complete cancelled and parent archived work; selected and null retain existing semantics',
  async () => {
    const recordId = pool.tasks[0];
    if (recordId === undefined) throw new Error('Missing fixture task');
    await d.command({
      command: 'task.complete',
      recordId,
      expectedRevision: await d.revision(recordId),
    });
    const archived = await d.archived(),
      cancelled = await d.cancelled();
    const shown = (await d.read({ mode: 'aggregate', person: w.teammate.personId })).tasks.map(
      (t) => t.id,
    );
    for (const excluded of [recordId, archived, cancelled]) expect(shown).not.toContain(excluded);
    expect((await d.read({ board: pool.boardA })).tasks.map((t) => t.id)).toContain(recordId);
    expect((await d.read({ board: null })).tasks.map((t) => t.id)).toContain(cancelled);
  },
);
live('a command owned move changes selected and unboarded readback', async () => {
  const recordId = pool.tasks[1];
  if (recordId === undefined) throw new Error('Missing fixture task');
  await d.command({
    command: 'task.move',
    recordId,
    expectedRevision: await d.revision(recordId),
    board: null,
  });
  expect((await d.read({ board: pool.boardB })).tasks).toEqual([]);
  expect((await d.read({ board: null })).tasks.map((t) => t.id)).toContain(recordId);
});
live(
  'record grants and foreign or fabricated aggregate identities disclose no rows or counts',
  async () => {
    const refused = await scopeRead(
      w,
      { read: 'task.board', mode: 'aggregate', person: w.teammate.personId },
      w.limited,
    );
    expect(refused).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
    expect(refused).not.toHaveProperty('tasks');
    expect(refused).not.toHaveProperty('owed');
    for (const identity of [
      { person: w.foreignOwner.personId },
      { client: w.foreignClient },
      { person: randomUUID() },
      { client: randomUUID() },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- each direct identity is independently refused.
      const answer = await scopeRead(w, { read: 'task.board', mode: 'aggregate', ...identity });
      expect(answer).toMatchObject({ refused: true, code: 'NOT_FOUND' });
      expect(JSON.stringify(answer)).not.toContain('canary');
    }
  },
);
live(
  'aggregate reads keep I13 and authentication auditing while task records remain unchanged',
  async () => {
    const records = () =>
      w.db.app.withBusiness(w.business, (tx) =>
        tx.query('select id,revision::text,data from records where business_id=$1 order by id', [
          w.business,
        ]),
      );
    const events = () => w.db.app.withBusiness(w.business, (tx) => readAuditEvents(tx));
    const attempts = () =>
      w.db.app.withBusiness(w.business, (tx) => readAuthenticationAttempts(tx, w.owner.presented));
    const beforeRecords = await records();
    const before = await events();
    const authBefore = await attempts();
    await d.read({ mode: 'aggregate', person: w.teammate.personId, client: w.clientA });
    expect(await records()).toEqual(beforeRecords);
    expect((await events()).slice(before.length)).toMatchObject([
      { command: 'task.board', operation_id: null, outcome: 'applied' },
    ]);
    expect(await attempts()).toHaveLength(authBefore.length + 1);
  },
);
live(
  'evidence query count stays bounded across pool sizes and fetches no comment bodies',
  async () => {
    for (const scope of [{ person: w.owner.personId }, { client: w.clientA }]) {
      const start = w.db.log.entries.length;
      // eslint-disable-next-line no-await-in-loop -- observe each admitted pool's actual statement trail.
      await scopeRead(w, { read: 'task.todos', ...scope });
      const statements = w.db.log.entries.slice(start).map((entry) => entry.text);
      const comments = statements.filter(
        (sql) => sql.includes('from_outside') && sql.includes("'task'"),
      );
      const tags = statements.filter((sql) => sql.includes('join public.tags g'));
      expect(comments).toHaveLength(1);
      expect(tags).toHaveLength(1);
      expect(comments[0]).not.toMatch(/then r\.data|select r\.id, r\.data(?:\s*,|\s+from)/u);
      expect(comments[0]).toContain('any(');
      expect(tags[0]).toContain('any(');
    }
  },
);
live('direct board reads recheck person grants and active membership', async () => {
  const reader = await enrol(w.db.app, w.business, 'Board vocabulary reader');
  const grant = await w.db.app.withBusiness(w.business, async (tx) => {
    await grantTo(tx, reader, 'read');
    return await grantTo(tx, reader, 'read', undefined, false, 'person');
  });
  const body = { read: 'task.board' as const, mode: 'aggregate', person: w.teammate.personId };
  expect(await scopeRead(w, body, reader)).toHaveProperty('tasks');
  await w.db.app.withBusiness(w.business, (tx) => revokeGrant(tx, grant));
  const refused = await scopeRead(w, body, reader);
  expect(refused).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
  expect(refused).not.toHaveProperty('tasks');
  const former = await enrol(w.db.app, w.business, 'Board former teammate');
  expect(
    await scopeRead(w, { read: 'task.board', mode: 'aggregate', person: former.personId }),
  ).toHaveProperty('tasks');
  await w.db.app.withBusiness(w.business, (tx) =>
    tx.query(
      'update memberships set active=false,ended_at=now() where business_id=$1 and person_id=$2 and active',
      [w.business, former.personId],
    ),
  );
  expect(
    await scopeRead(w, { read: 'task.board', mode: 'aggregate', person: former.personId }),
  ).toMatchObject({ refused: true, code: 'NOT_FOUND' });
});
