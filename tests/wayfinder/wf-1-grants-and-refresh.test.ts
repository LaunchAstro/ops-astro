// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines, max-lines-per-function -- the review's proofs, kept as written on one shared world */
// Review proofs for PR #355 at 3fac44c (Sol round 1, R/sol/PRV-oa-355-R1.md) and c653fda (round 2,
// R/sol/P14-FIX1.md): one case per finding.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { withSession } from '../../packages/core-records/src/identity/login-resolution.ts';
import { shareRecord } from '../../packages/core-records/src/authority/shares.ts';
import { insertPerson } from '../identity/fixture.ts';
import { executeCommand, runCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { catalogue, EMAIL_SEND, emailAdapter } from '../../packages/core-connectors/src/index.ts';
import { sendInboxEmail, type Broker } from '../../packages/core-custody/src/index.ts';
import { codeOf, must, wayfinderWorld, type Decider, type WayfinderWorld } from './world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();
const noop = (): void => undefined;

/** A pool whose every query runs `after` once it has answered, so a test can pause there. */
function interceptOn(
  pool: Database,
  after: (sql: string, parameters: readonly unknown[]) => Promise<void>,
): Database {
  return {
    ...pool,
    async withBusiness(businessId, run) {
      return await pool.withBusiness(businessId, async (tx) => {
        const wrapped: typeof tx = {
          ...tx,
          async query<Row>(sql: string, parameters: readonly unknown[] = []) {
            const rows = await tx.query<Row>(sql, parameters);
            await after(sql, parameters);
            return rows;
          },
        };
        return await run(wrapped);
      });
    },
  };
}

const unreached = (): Promise<never> =>
  Promise.reject(new Error('custody not reached by an addressless recipient'));

// No address is installed, so a successful access check refuses NO_ADDRESS before custody.
const broker: Broker = {
  custody: {
    pid: 0,
    stderr: () => '',
    kill: noop,
    stop: () => Promise.resolve(),
    raw: unreached,
    dispatch: unreached,
    describe: unreached,
  },
  operations: catalogue([EMAIL_SEND]),
  providers: new Map([['resend', { build: emailAdapter, price: () => 0 }]]),
  routes: [
    {
      key: 'email',
      reach: 'cloud',
      provider: 'resend',
      credentialRef: 'unused',
      credentialKind: 'api_key',
      installation: 'here',
      ceiling: 4,
    },
  ],
  installation: 'here',
  audit: () => Promise.resolve(),
};

describe.skipIf(serverUrl === undefined)(
  'WF-1 map grants, inbox reach and map refresh under concurrency',
  () => {
    let w: WayfinderWorld;
    let owner: Decider;
    let second: Database;

    beforeAll(async () => {
      w = await wayfinderWorld('sol355', 'sol355');
      owner = await w.decider('owner');
      second = connect(w.db.appUrl);
    });
    afterAll(async () => {
      await second?.close();
      await w?.drop();
    });

    function latch() {
      let release: () => void = noop;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    }

    async function waitForBlockedQuery() {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
        const rows = await w.db.admin.execute<{ blocked: boolean }>(
          `select exists (select 1 from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and wait_event_type = 'Lock') as blocked`,
        );
        if (rows[0]?.blocked) return;
        // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
        await delay(10);
      }
      throw new Error('second caller never reached the expected database lock');
    }

    async function frontier(mapId: string) {
      const rows = await w.db.admin.execute<{ ticket_id: string }>(
        `select ticket_id from map_frontier where business_id = $1 and map_id = $2 order by position`,
        [w.business, mapId],
      );
      return rows.map((row) => row.ticket_id);
    }

    it('WF-1 a map record read grant covers its ticket', async () => {
      const map = await w.create(owner, { title: 'grant map' }, { taskType: 'map' });
      const holder = await w.member('map-reader', ['read', 'write'], {
        kind: 'record',
        id: map.id,
      });
      const ticket = await w.create(
        holder,
        { title: 'ticket made with map grant' },
        { parentId: map.id },
      );
      expect(codeOf(await w.read(holder, { read: 'task.read', recordId: map.id }))).toBe('applied');
      expect(codeOf(await w.read(holder, { read: 'task.read', recordId: ticket.id }))).toBe(
        'applied',
      );
    });

    it('WF-1 completing an external blocker refreshes the blocked map frontier', async () => {
      const map = await w.create(owner, { title: 'blocked map' }, { taskType: 'map' });
      const ticket = await w.create(owner, { title: 'blocked ticket' }, { parentId: map.id });
      const blocker = await w.create(owner, { title: 'blocker outside map' });
      await w.db.app.withBusiness(w.business, async (tx) => {
        await tx.query(
          `insert into record_links (business_id, id, link_type, from_record_id, to_record_id)
      values ($1, $2, 'blocks', $3, $4)`,
          [w.business, randomUUID(), blocker.id, ticket.id],
        );
      });
      expect(await frontier(map.id)).toStrictEqual([]);
      must(
        await w.as(owner, {
          command: 'task.complete',
          recordId: blocker.id,
          expectedRevision: await w.revisionOf(blocker.id),
        }),
        'complete blocker',
      );
      expect(await frontier(map.id)).toStrictEqual([ticket.id]);
    });

    it('WF-1 concurrent ticket completions cannot lose a map summary count', async () => {
      const map = await w.create(owner, { title: 'summary race map' }, { taskType: 'map' });
      // Assigned tickets are absent from the frontier, so its rows cannot incidentally serialise these writes.
      const a = await w.create(owner, { title: 'race A' }, { parentId: map.id });
      const b = await w.create(owner, { title: 'race B' }, { parentId: map.id });
      await w.db.app.withBusiness(w.business, async (tx) => {
        await tx.query(
          `update records set data = data || jsonb_build_object('assignee', $3::text)
      where business_id = $1 and id = any($2::uuid[])`,
          [w.business, [a.id, b.id], owner.personId],
        );
      });
      expect(await frontier(map.id)).toStrictEqual([]);
      const ready = latch();
      const commit = latch();
      const first = withSession(w.db.app, w.business, owner.presented, async (tx, session) => {
        must(
          await runCommand(tx, session, 'api', {
            command: 'task.complete',
            operationId: randomUUID(),
            recordId: a.id,
            expectedRevision: await w.revisionOf(a.id),
          }),
          'complete A',
        );
        ready.release();
        await commit.promise;
      });
      await ready.promise;
      const next = executeCommand(second, w.business, owner.presented, 'api', {
        command: 'task.complete',
        operationId: randomUUID(),
        recordId: b.id,
        expectedRevision: await w.revisionOf(b.id),
      });
      try {
        await waitForBlockedQuery();
      } finally {
        commit.release();
      }
      await first;
      must(await next, 'complete B');
      const summary = await w.db.admin.execute<{ open_tickets: number; closed_tickets: number }>(
        `select open_tickets, closed_tickets from map_summaries where business_id = $1 and map_id = $2`,
        [w.business, map.id],
      );
      const actual = await w.db.admin.execute<{ n: string }>(
        `select count(*)::text as n from records r join records s
       on s.business_id = r.business_id and s.id = r.uuid_1
      where r.business_id = $1 and r.uuid_4 = $2 and s.data->>'machine_category' = 'completed'`,
        [w.business, map.id],
      );
      expect(actual[0]?.n).toBe('2');
      expect(summary[0]).toStrictEqual({ open_tickets: 0, closed_tickets: 2 });
    });

    it('WF-1 writes to two tasks under one ordinary parent do not queue on a map summary', async () => {
      const parent = await w.create(owner, { title: 'ordinary parent' });
      const a = await w.create(owner, { title: 'ordinary child A' }, { parentId: parent.id });
      const b = await w.create(owner, { title: 'ordinary child B' }, { parentId: parent.id });
      const touch = `update records set data = data || '{"note":"touched"}'::jsonb
    where business_id = $1 and id = $2`;
      const ready = latch();
      const commit = latch();
      const first = w.db.app.withBusiness(w.business, async (tx) => {
        await tx.query(touch, [w.business, a.id]);
        ready.release();
        await commit.promise;
      });
      await ready.promise;
      let finished = false;
      const next = second
        .withBusiness(w.business, async (tx) => await tx.query(touch, [w.business, b.id]))
        .finally(() => {
          finished = true;
        });
      let queued = false;
      let settledWhileHeld = false;
      try {
        // oxlint-disable-next-line no-unmodified-loop-condition -- the second write's settling sets it
        for (let attempt = 0; !finished && !queued && attempt < 500; attempt += 1) {
          // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
          const waiting = await w.db.admin.execute<{ blocked: boolean }>(
            `select exists (select 1 from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid()
            and wait_event_type = 'Lock') as blocked`,
          );
          queued = waiting[0]?.blocked === true;
          // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
          if (!queued) await delay(10);
        }
        settledWhileHeld = finished;
      } finally {
        commit.release();
      }
      await first;
      await next;
      expect(queued).toBe(false);
      expect(settledWhileHeld).toBe(true);
    });

    it('WF-1 a map A grant cannot write a ticket after its concurrent move to map B', async () => {
      const a = await w.create(owner, { title: 'authority map A' }, { taskType: 'map' });
      const b = await w.create(owner, { title: 'authority map B' }, { taskType: 'map' });
      const ticket = await w.create(owner, { title: 'client B canary' }, { parentId: a.id });
      const holder = await w.member('only-map-a', ['write'], { kind: 'record', id: a.id });
      const oldRevision = await w.revisionOf(ticket.id);
      const ready = latch();
      const commit = latch();
      const mover = withSession(w.db.app, w.business, owner.presented, async (tx, session) => {
        must(
          await runCommand(tx, session, 'api', {
            command: 'task.reparent',
            operationId: randomUUID(),
            recordId: ticket.id,
            expectedRevision: oldRevision,
            parentId: b.id,
          }),
          'move to B',
        );
        ready.release();
        await commit.promise;
      });
      await ready.promise;
      // A future revision is a caller-controlled integer, so it cannot repair the stale scope check.
      const writer = executeCommand(second, w.business, holder.presented, 'api', {
        command: 'task.update',
        operationId: randomUUID(),
        recordId: ticket.id,
        expectedRevision: oldRevision + 1,
        fields: { title: 'written outside map A grant' },
      });
      try {
        await waitForBlockedQuery();
      } finally {
        commit.release();
      }
      await mover;
      const answer = await writer;
      expect(codeOf(answer)).toBe('SCOPE_NOT_GRANTED');
      const saved = await w.db.admin.execute<{ title: string; parent: string }>(
        `select data->>'title' as title, data->>'parent' as parent from records
      where business_id = $1 and id = $2`,
        [w.business, ticket.id],
      );
      expect(saved[0]).toStrictEqual({ title: 'client B canary', parent: b.id });
    });

    it('WF-1 a client reader cannot receive a map title through their assignment inbox', async () => {
      const plain = await w.create(owner, { title: 'INTERNAL-MAP-INBOX-CANARY' });
      const client = await w.member('client-view-reader', ['read'], {
        kind: 'record',
        id: plain.id,
      });
      // Preset-defined roles outside owner/admin/member receive the shared client projection.
      await w.db.app.withBusiness(w.business, async (tx) => {
        await tx.query(
          `update memberships set role_key = 'client' where business_id = $1 and person_id = $2`,
          [w.business, client.personId],
        );
      });
      await w.grant(owner, 'assign');
      must(
        await w.as(owner, {
          command: 'task.assign',
          recordId: plain.id,
          expectedRevision: await w.revisionOf(plain.id),
          fields: { assignee: client.personId },
        }),
        'assign',
      );
      // A legitimate assignment predates the retype; no inbox row is planted by this proof.
      must(
        await w.as(owner, {
          command: 'task.set_type',
          recordId: plain.id,
          expectedRevision: await w.revisionOf(plain.id),
          taskType: 'map',
        }),
        'retype map',
      );
      expect(codeOf(await w.read(client, { read: 'task.read', recordId: plain.id }))).toBe(
        'NOT_FOUND',
      );
      const inbox = await w.read(client, { read: 'inbox.read' });
      expect(codeOf(inbox)).toBe('applied');
      expect(JSON.stringify(inbox)).not.toContain('INTERNAL-MAP-INBOX-CANARY');
      expect(JSON.stringify(inbox)).not.toContain(plain.id);
    });

    it('WF-1 retyping a parent to map cannot race a client share on its child', async () => {
      const parent = await w.create(owner, { title: 'unshared parent' });
      const child = await w.create(owner, { title: 'child to be shared' }, { parentId: parent.id });
      await w.grant(owner, 'share');
      const outsider = await w.db.app.withBusiness(
        w.business,
        async (tx) => await insertPerson(tx, `outside-${randomUUID()}`),
      );
      const ready = latch();
      const commit = latch();
      const retyper = withSession(w.db.app, w.business, owner.presented, async (tx, session) => {
        must(
          await runCommand(tx, session, 'api', {
            command: 'task.set_type',
            operationId: randomUUID(),
            recordId: parent.id,
            expectedRevision: await w.revisionOf(parent.id),
            taskType: 'map',
          }),
          'retype parent',
        );
        ready.release();
        await commit.promise;
      });
      await ready.promise;
      let finished = false;
      const sharing = second
        .withBusiness(
          w.business,
          async (tx) =>
            await shareRecord(tx, owner, {
              collection: 'task',
              recordId: child.id,
              personId: outsider,
            }),
        )
        .finally(() => {
          finished = true;
        });
      try {
        // A corrected share may wait for the parent retype's lock; release that lock once observed.
        // oxlint-disable-next-line no-unmodified-loop-condition -- the share's settling sets it
        for (let attempt = 0; !finished && attempt < 500; attempt += 1) {
          // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
          const waiting = await w.db.admin.execute<{ blocked: boolean }>(
            `select exists (select 1 from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid()
            and wait_event_type = 'Lock') as blocked`,
          );
          if (waiting[0]?.blocked) break;
          // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
          await delay(10);
        }
      } finally {
        commit.release();
      }
      await retyper;
      await sharing;
      const rows = await w.db.admin.execute<{ n: string }>(
        `select count(*)::text as n from grants g join records c
       on c.business_id = g.business_id and c.id = g.scope_id
      join records p on p.business_id = c.business_id and p.id = c.uuid_4
     where g.business_id = $1 and c.id = $2 and g.subject_id = $3
       and g.action = 'read' and g.revoked_at is null and p.data->>'type' = 'map'`,
        [w.business, child.id, outsider],
      );
      expect(rows[0]?.n).toBe('0');
    });

    it('WF-1 retyping a parent to map cannot race a reparent that files a shared task under it', async () => {
      const parent = await w.create(owner, { title: 'parent about to become a map' });
      const shared = await w.create(owner, { title: 'shared task moving in' });
      await w.grant(owner, 'share');
      const outsider = await w.db.app.withBusiness(
        w.business,
        async (tx) => await insertPerson(tx, `outside-${randomUUID()}`),
      );
      await w.db.app.withBusiness(
        w.business,
        async (tx) =>
          await shareRecord(tx, owner, {
            collection: 'task',
            recordId: shared.id,
            personId: outsider,
          }),
      );
      const ready = latch();
      const commit = latch();
      const retyper = withSession(w.db.app, w.business, owner.presented, async (tx, session) => {
        must(
          await runCommand(tx, session, 'api', {
            command: 'task.set_type',
            operationId: randomUUID(),
            recordId: parent.id,
            expectedRevision: await w.revisionOf(parent.id),
            taskType: 'map',
          }),
          'retype parent',
        );
        ready.release();
        await commit.promise;
      });
      await ready.promise;
      // The reparent reads the parent while the retype is uncommitted, then meets its lock.
      const moving = w.asOnSecond(owner, {
        command: 'task.reparent',
        recordId: shared.id,
        expectedRevision: await w.revisionOf(shared.id),
        parentId: parent.id,
      });
      try {
        await waitForBlockedQuery();
      } finally {
        commit.release();
      }
      await retyper;
      await moving;
      const rows = await w.db.admin.execute<{ n: string }>(
        `select count(*)::text as n from grants g join records c
       on c.business_id = g.business_id and c.id = g.scope_id
      join records p on p.business_id = c.business_id and p.id = c.uuid_4
     where g.business_id = $1 and c.id = $2 and g.subject_id = $3
       and g.action = 'read' and g.revoked_at is null and p.data->>'type' = 'map'`,
        [w.business, shared.id, outsider],
      );
      expect(rows[0]?.n).toBe('0');
    });

    // From Sol's PR #379 round 1 proofs (PRV-oa-379-R1-0e9c9b029.patch), the read half of
    // the map grant's reach, brought here with that reach (its `map()` is a map task here).
    function intercept(
      after: (sql: string, parameters: readonly unknown[]) => Promise<void>,
    ): Database {
      return interceptOn(w.db.app, after);
    }

    it('WF-1 person to person map grant cannot read content written after a ticket moves outside that grant', async () => {
      const a = await w.create(owner, { title: 'reader map' }, { taskType: 'map' });
      const b = await w.create(owner, { title: 'private map' }, { taskType: 'map' });
      const ticket = await w.create(owner, { title: 'moving ticket' }, { parentId: a.id });
      const reader = await w.member('moving-reader', ['read'], { kind: 'record', id: a.id });
      let fired = false;
      const db = intercept(async (sql, parameters) => {
        if (
          fired ||
          !sql.includes("select r.data ->> 'type' as type") ||
          parameters[1] !== ticket.id
        )
          return;
        fired = true;
        must(
          await w.asOnSecond(owner, {
            command: 'task.reparent',
            recordId: ticket.id,
            expectedRevision: await w.revisionOf(ticket.id),
            parentId: b.id,
          }),
          'concurrent move',
        );
        must(
          await w.asOnSecond(owner, {
            command: 'task.update',
            recordId: ticket.id,
            expectedRevision: await w.revisionOf(ticket.id),
            fields: { title: 'private content written only after moving to map B' },
          }),
          'private update after moving',
        );
      });
      const answer = await executeRead(db, w.business, reader.presented, {
        read: 'task.read',
        recordId: ticket.id,
      });
      expect(fired).toBe(true);
      expect(codeOf(await w.read(reader, { read: 'task.read', recordId: ticket.id }))).toBe(
        'SCOPE_NOT_GRANTED',
      );
      expect(JSON.stringify(answer)).not.toContain(
        'private content written only after moving to map B',
      );
    });

    // Sol round 2 proofs for PR #355 at c653fda (R/sol/P14-FIX1.md), assertions and interleavings as written.
    it('WF-1 a client inbox cannot disclose map content written after its access query', async () => {
      await w.grant(owner, 'assign');
      const plain = await w.create(owner, { title: 'shareable assignment' });
      const client = await w.member('inbox-client', ['read'], { kind: 'record', id: plain.id });
      await w.db.app.withBusiness(w.business, async (tx) => {
        await tx.query(
          `update memberships set role_key = 'client' where business_id = $1 and person_id = $2`,
          [w.business, client.personId],
        );
      });
      must(
        await w.as(owner, {
          command: 'task.assign',
          recordId: plain.id,
          expectedRevision: await w.revisionOf(plain.id),
          fields: { assignee: client.personId },
        }),
        'assign',
      );
      expect(JSON.stringify(await w.read(client, { read: 'inbox.read' }))).toContain(plain.id);
      let fired = false;
      const db = intercept(async (sql) => {
        if (fired || !sql.includes('from shown s')) return;
        fired = true;
        must(
          await w.asOnSecond(owner, {
            command: 'task.set_type',
            recordId: plain.id,
            expectedRevision: await w.revisionOf(plain.id),
            taskType: 'map',
          }),
          'retype',
        );
        must(
          await w.asOnSecond(owner, {
            command: 'task.update',
            recordId: plain.id,
            expectedRevision: await w.revisionOf(plain.id),
            fields: { title: 'PRIVATE-MAP-CONTENT-AFTER-RETYPE' },
          }),
          'private map content',
        );
      });
      const answer = await executeRead(db, w.business, client.presented, { read: 'inbox.read' });
      expect(fired).toBe(true);
      expect(codeOf(await w.read(client, { read: 'task.read', recordId: plain.id }))).toBe(
        'NOT_FOUND',
      );
      expect(JSON.stringify(answer)).not.toContain('PRIVATE-MAP-CONTENT-AFTER-RETYPE');
    });

    it('WF-1 a map read grant covers its ticket assignment in the recipient inbox', async () => {
      await w.grant(owner, 'assign');
      const map = await w.create(owner, { title: 'assignment map' }, { taskType: 'map' });
      const ticket = await w.create(owner, { title: 'MAP-GRANT-ASSIGNMENT' }, { parentId: map.id });
      const reader = await w.member('map-assignee', ['read'], { kind: 'record', id: map.id });
      must(
        await w.as(owner, {
          command: 'task.assign',
          recordId: ticket.id,
          expectedRevision: await w.revisionOf(ticket.id),
          fields: { assignee: reader.personId },
        }),
        'assign map ticket',
      );
      expect(codeOf(await w.read(reader, { read: 'task.read', recordId: ticket.id }))).toBe(
        'applied',
      );
      const items = await w.db.admin.execute<{ n: string }>(
        `select count(*)::text as n from inbox_items where business_id = $1 and recipient_person_id = $2 and subject_record_id = $3 and reason = 'assignment' and work_state = 'open'`,
        [w.business, reader.personId, ticket.id],
      );
      expect(items[0]?.n).toBe('1');
      expect(JSON.stringify(await w.read(reader, { read: 'inbox.read' }))).toContain(
        'MAP-GRANT-ASSIGNMENT',
      );
    });

    // Sol round 3 proof for PR #355 at 3c1de14 (R/sol/P14-FIX2.md, criterion 5), assertions and interleaving as written.
    it('WF-1 a map-only assignee email check cannot deadlock against a concurrent reassignment', async () => {
      await w.grant(owner, 'assign');
      const map = await w.create(owner, { title: 'mail lock map' }, { taskType: 'map' });
      const ticket = await w.create(owner, { title: 'mail lock ticket' }, { parentId: map.id });
      const recipient = await w.member('mail-map-recipient', ['read'], {
        kind: 'record',
        id: map.id,
      });
      const replacement = await w.member('mail-map-replacement', ['read'], {
        kind: 'record',
        id: map.id,
      });
      must(
        await w.as(owner, {
          command: 'task.assign',
          recordId: ticket.id,
          expectedRevision: await w.revisionOf(ticket.id),
          fields: { assignee: recipient.personId },
        }),
        'initial assignment',
      );
      const [item] = await w.db.admin.execute<{ id: string }>(
        "select id from inbox_items where business_id = $1 and subject_record_id = $2 and recipient_person_id = $3 and work_state = 'open'",
        [w.business, ticket.id, recipient.personId],
      );
      expect(item).toBeDefined();
      const taskHeld = latch();
      const resumeAssign = latch();
      const itemHeld = latch();
      const resumeMail = latch();
      let assignPaused = false;
      let mailPaused = false;
      const assignmentDb = intercept(async (sql, parameters) => {
        if (
          assignPaused ||
          !sql.includes('select id, revision::text as revision, data') ||
          !sql.includes('for update') ||
          parameters[2] !== ticket.id
        )
          return;
        assignPaused = true;
        taskHeld.release();
        await resumeAssign.promise;
      });
      const mailDb = interceptOn(second, async (sql, parameters) => {
        if (
          mailPaused ||
          !sql.includes('recipient_person_id as recipient') ||
          !sql.includes('for update') ||
          parameters[1] !== item?.id
        )
          return;
        mailPaused = true;
        itemHeld.release();
        await resumeMail.promise;
      });
      const assigning = executeCommand(assignmentDb, w.business, owner.presented, 'api', {
        command: 'task.assign',
        operationId: randomUUID(),
        recordId: ticket.id,
        expectedRevision: await w.revisionOf(ticket.id),
        fields: { assignee: replacement.personId },
      });
      await taskHeld.promise;
      const subdomain = 'send.example.test';
      const mailing = sendInboxEmail(mailDb, w.business, item?.id ?? '', broker, {
        appOrigin: 'https://ops.example.test',
        from: `hello@${subdomain}`,
        sender: {
          subdomain,
          verified: true,
          records: { dkim: 'verified', spf: 'verified', returnPathMx: 'verified' },
          dmarc: 'reject',
          mock: false,
        },
      });
      const outcomes = Promise.allSettled([assigning, mailing]);
      await itemHeld.promise;
      try {
        resumeMail.release();
        await waitForBlockedQuery();
      } finally {
        resumeAssign.release();
      }
      const settled = await outcomes;
      const faults = settled.flatMap((result) =>
        result.status === 'rejected' ? [String(result.reason.code)] : [],
      );
      expect(assignPaused && mailPaused).toBe(true);
      expect(faults).toStrictEqual([]);
    });
  },
);
