// SPDX-License-Identifier: AGPL-3.0-only
//
// T04 and M03, against the operations that exist today rather than against a
// fixture insert.
//
// `tenancy-wrapper.test.ts` reads the same log, but what it put in it was the
// test's own SQL. The ledger asks for the shape of a *production* operation:
// begin, then the tenant setting set locally, then the work, then commit or
// rollback -- and for the no-runtime-DDL claim to be made over a capture that
// is not empty, because a silent log clears everything.
//
// So six selected production operations run here, through `executeCommand` and
// `executeRead`, into a log of their own: the `task.create`, `task.assign` and
// `task.complete` mutations, and the `task.read`, `task.board` and
// `person.list` reads. Six, and not every operation the tree implements: what
// is proved below is the shape a serving transaction has, which is the same
// shape in all of them, and this suite is not a coverage claim over the
// surface.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  createStatementLog,
  type RecordedStatement,
} from '../../packages/core-records/src/tenancy/statements.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { executeRead, isReadRefusal } from '../../packages/core-records/src/reads/execute.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime statements: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

/** The statements of one transaction, from its begin to its commit or rollback. */
function transactions(entries: readonly RecordedStatement[]): readonly RecordedStatement[][] {
  const found: RecordedStatement[][] = [];
  let open: RecordedStatement[] | undefined;
  for (const entry of entries) {
    if (/^begin/iu.test(entry.text)) {
      open = [entry];
      found.push(open);
      continue;
    }
    open?.push(entry);
    if (/^(commit|rollback)/iu.test(entry.text)) open = undefined;
  }
  return found;
}

describe.skipIf(serverUrl === undefined)('T04/M03: what a production operation sends', () => {
  let db: FreshDatabase;
  let app: Database;
  const log = createStatementLog();
  let business: string;
  let worker: Member;
  let helper: Member;
  let taskId: string;

  const run = async (command: Parameters<typeof executeCommand>[4]) =>
    await executeCommand(app, business, worker.presented, 'api', command);

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 's' });
    business = await insertBusiness(db.app, 'runtime-statements');
    await installSpine(db.app, business);
    worker = await enrol(db.app, business, 'worker');
    helper = await enrol(db.app, business, 'helper');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, worker, 'read');
      await grantTo(tx, worker, 'write');
      await grantTo(tx, worker, 'assign');
      // `person.list` is read on the person collection, which the task
      // fixture's helper does not cover.
      const people = await issueGrant(tx, [], {
        subject: { kind: 'person', id: worker.personId },
        scope: WHOLE_BUSINESS,
        collection: 'person',
        action: 'read',
        canDelegate: false,
        parentGrantId: null,
        grantedByActorId: worker.actorId,
      });
      if (!people.ok) throw new Error(`person read grant refused ${people.refusal.code}`);
    });

    // A connection of its own, so the capture below is the operations' and not
    // the fixture's. Everything above went through db.app.
    app = connect(db.appUrl, { source: 'runtime', log, max: 1 });

    const made = await run({
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'the operation under capture' },
    } as Parameters<typeof executeCommand>[4]);
    if (isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
    taskId = made.recordId ?? '';

    const assigned = await run({
      command: 'task.assign',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: made.revision ?? 0,
      fields: { assignee: helper.personId },
    } as Parameters<typeof executeCommand>[4]);
    if (isCommandRefusal(assigned)) throw new Error(`task.assign refused ${assigned.code}`);

    const completed = await run({
      command: 'task.complete',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: assigned.revision ?? 0,
    } as Parameters<typeof executeCommand>[4]);
    if (isCommandRefusal(completed)) throw new Error(`task.complete refused ${completed.code}`);

    for (const request of [
      { read: 'task.read', recordId: taskId },
      { read: 'task.board', board: null },
      { read: 'person.list' },
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const seen = await executeRead(app, business, worker.presented, request);
      if (isReadRefusal(seen)) throw new Error(`${request.read} refused ${seen.code}`);
    }
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  const runtime = (): readonly RecordedStatement[] =>
    log.entries.filter((entry) => entry.source === 'runtime');

  describe('the capture is real', () => {
    it('is not empty, which is what makes the assertions below mean anything', () => {
      expect(runtime().length).toBeGreaterThan(30);
      expect(transactions(runtime()).length).toBeGreaterThanOrEqual(6);
    });

    it('holds the writes the task commands actually made', () => {
      const text = runtime()
        .map((entry) => entry.text.toLowerCase())
        .join('\n');
      expect(text).toMatch(/insert into records/u);
      expect(text).toMatch(/insert into operations/u);
      expect(text).toMatch(/insert into audit_events/u);
      expect(text).toMatch(/update records/u);
    });
  });

  describe('T04: the tenant setting is set inside the serving transaction', () => {
    it('begins, then sets the business locally, in every transaction', () => {
      const opened = transactions(runtime());
      expect(opened.length).toBeGreaterThanOrEqual(6);
      for (const [at, statements] of opened.entries()) {
        expect({
          at,
          second: statements[1]?.text.replaceAll(/\s+/gu, ' ').trim(),
        }).toStrictEqual({
          at,
          second: `select set_config('app.business_id', $1, true)`,
        });
      }
    });

    it('ends every transaction it opened, and never sets the business outside one', () => {
      const opened = transactions(runtime());
      for (const statements of opened) {
        expect(statements.at(-1)?.text.toLowerCase()).toMatch(/^(commit|rollback)/u);
      }
      const loose = runtime().filter(
        (entry, at) =>
          /set_config\('app\.business_id'/u.test(entry.text) &&
          !/^begin/iu.test(runtime()[at - 1]?.text ?? ''),
      );
      expect(loose).toStrictEqual([]);
    });

    it('never sends a session-wide form of the setting', () => {
      const wide = runtime().filter(
        (entry) =>
          /set_config\('app\.business_id'[^)]*,\s*false\s*\)/iu.test(entry.text) ||
          /^set\s+app\.business_id/iu.test(entry.text),
      );
      expect(wide).toStrictEqual([]);
    });
  });

  describe('M03: the application changes no schema', () => {
    it('sent nothing the log cannot clear of changing one', () => {
      expect(
        log
          .schemaChanging()
          .filter((entry) => entry.source === 'runtime')
          .map((entry) => `${entry.kind}: ${entry.text}`),
      ).toStrictEqual([]);
    });

    it('is refused by the server for every shape of injected DDL', async () => {
      for (const statement of [
        'create table public.injected (id uuid primary key)',
        'alter table public.records add column injected text',
        'create index injected_idx on public.records (id)',
        'drop table public.records',
      ]) {
        // oxlint-disable-next-line no-await-in-loop
        await expect(app.withBusiness(business, (tx) => tx.query(statement))).rejects.toThrow(
          /permission denied|must be owner/iu,
        );
      }
    });

    it('recorded those attempts as schema-changing, so the assertion would have caught them', () => {
      const injected = log
        .schemaChanging()
        .filter((entry) => /injected/u.test(entry.text) || /^drop table/iu.test(entry.text));
      expect(injected.length).toBe(4);
      expect(injected.every((entry) => entry.kind === 'ddl')).toBe(true);
    });

    it('is a claim about the application, not about the tree: the migrations did change it', () => {
      expect(db.log.schemaChanging().some((entry) => entry.source === 'migration')).toBe(true);
    });
  });
});
