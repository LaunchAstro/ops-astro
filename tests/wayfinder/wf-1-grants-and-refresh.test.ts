// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines, max-lines-per-function -- the review's proofs, kept as written on one shared world */
// Review proofs for PR #355 at 3fac44c (Sol round 1, R/sol/PRV-oa-355-R1.md) and c653fda (round 2,
// R/sol/P14-FIX1.md): one case per finding.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { withSession } from '../../packages/core-records/src/identity/login-resolution.ts';
import { shareRecord } from '../../packages/core-records/src/authority/shares.ts';
import { insertPerson } from '../identity/fixture.ts';
import { executeCommand, runCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { boardReach } from '../../packages/core-commands/src/reads/live-join.ts';
import { readUnattended } from '../../packages/core-records/src/inbox/unattended.ts';
import { raiseInboxItem } from '../../packages/core-records/src/inbox/items.ts';
import { addClient, grantTo, type Member } from '../commands/fixture.ts';
import {
  codeOf,
  must,
  wayfinderWorld,
  type Decider,
  type Made,
  type WayfinderWorld,
} from './world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();
const noop = (): void => undefined;

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
      return {
        ...w.db.app,
        async withBusiness(businessId, run) {
          return await w.db.app.withBusiness(businessId, async (tx) => {
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

    // Sol round 3 proofs for PR #355 at 3c1de14 (R/sol/P14-FIX2.md), assertions and interleavings as written.
    it('WF-1 a client-view operator cannot disclose an internal map through unattended inbox', async () => {
      await w.grant(owner, 'assign');
      const plain = await w.create(owner, { title: 'internal unattended map' });
      const viewer = await w.member('client-operator', ['read'], { kind: 'record', id: plain.id });
      const recipient = await w.member('unattended-recipient', ['read'], {
        kind: 'record',
        id: plain.id,
      });
      await w.db.app.withBusiness(w.business, async (tx) => {
        await grantTo(tx, viewer, 'read', { kind: 'business', id: null }, false, 'operations');
        await tx.query(
          "update memberships set role_key = 'client' where business_id = $1 and person_id = $2",
          [w.business, viewer.personId],
        );
        await tx.query(
          'update person_logins set active = false, deactivated_at = now() where business_id = $1 and person_id = $2',
          [w.business, recipient.personId],
        );
      });
      must(
        await w.as(owner, {
          command: 'task.assign',
          recordId: plain.id,
          expectedRevision: await w.revisionOf(plain.id),
          fields: { assignee: recipient.personId },
        }),
        'assign',
      );
      expect(JSON.stringify(await w.read(viewer, { read: 'inbox.unattended' }))).toContain(
        plain.id,
      );
      must(
        await w.as(owner, {
          command: 'task.set_type',
          recordId: plain.id,
          expectedRevision: await w.revisionOf(plain.id),
          taskType: 'map',
        }),
        'retype to internal map',
      );
      expect(codeOf(await w.read(viewer, { read: 'task.read', recordId: plain.id }))).toBe(
        'NOT_FOUND',
      );
      const answer = await w.read(viewer, { read: 'inbox.unattended' });
      expect(codeOf(answer)).toBe('applied');
      expect(JSON.stringify(answer)).not.toContain(plain.id);
      expect(JSON.stringify(answer)).not.toContain(recipient.personId);
    });

    it('WF-1 a map-only create grant cannot survive a concurrent retype of its parent out of map', async () => {
      const map = await w.create(
        owner,
        { title: 'map becoming an ordinary parent' },
        { taskType: 'map' },
      );
      const writer = await w.member('map-only-creator', ['write'], { kind: 'record', id: map.id });
      const ready = latch();
      const commit = latch();
      const retyping = withSession(w.db.app, w.business, owner.presented, async (tx, session) => {
        must(
          await runCommand(tx, session, 'api', {
            command: 'task.set_type',
            operationId: randomUUID(),
            recordId: map.id,
            expectedRevision: await w.revisionOf(map.id),
            taskType: 'task',
          }),
          'retype away from map',
        );
        ready.release();
        await commit.promise;
      });
      await ready.promise;
      const creating = executeCommand(second, w.business, writer.presented, 'api', {
        command: 'task.create',
        operationId: randomUUID(),
        parentId: map.id,
        fields: { title: 'CREATED-AFTER-MAP-AUTHORITY-ENDED' },
      });
      try {
        await waitForBlockedQuery();
      } finally {
        commit.release();
      }
      await retyping;
      const answer = await creating;
      const steady = await w.as(writer, {
        command: 'task.create',
        parentId: map.id,
        fields: { title: 'ordinary parent control' },
      });
      expect(codeOf(steady)).toBe('SCOPE_NOT_GRANTED');
      expect(codeOf(answer)).toBe('SCOPE_NOT_GRANTED');
      const rows = await w.db.admin.execute<{ n: string }>(
        `select count(*)::text as n from records where business_id = $1 and data->>'title' = $2`,
        [w.business, 'CREATED-AFTER-MAP-AUTHORITY-ENDED'],
      );
      expect(rows[0]?.n).toBe('0');
    });

    it('WF-1 a map read grant governs recipient reach and operator visibility in unattended inbox', async () => {
      await w.grant(owner, 'assign');
      const map = await w.create(owner, { title: 'unattended map' }, { taskType: 'map' });
      const ticket = await w.create(
        owner,
        { title: 'unattended map ticket' },
        { parentId: map.id },
      );
      const recipient = await w.member('unreachable-map-reader', ['read'], {
        kind: 'record',
        id: map.id,
      });
      const operator = await w.member('map-operator', ['read'], { kind: 'record', id: map.id });
      must(
        await w.as(owner, {
          command: 'task.assign',
          recordId: ticket.id,
          expectedRevision: await w.revisionOf(ticket.id),
          fields: { assignee: recipient.personId },
        }),
        'assign',
      );
      const healthy = await w.db.app.withBusiness(
        w.business,
        async (tx) => await readUnattended(tx, owner.personId),
      );
      expect.soft(healthy.map((item) => item.subjectRecordId)).not.toContain(ticket.id);
      await w.db.app.withBusiness(w.business, async (tx) => {
        await grantTo(tx, operator, 'read', { kind: 'business', id: null }, false, 'operations');
        await tx.query(
          'update person_logins set active = false, deactivated_at = now() where business_id = $1 and person_id = $2',
          [w.business, recipient.personId],
        );
      });
      const control = await w.db.app.withBusiness(
        w.business,
        async (tx) => await readUnattended(tx, owner.personId),
      );
      expect(control.map((item) => item.subjectRecordId)).toContain(ticket.id);
      expect(codeOf(await w.read(operator, { read: 'task.read', recordId: ticket.id }))).toBe(
        'applied',
      );
      const listed = await w.read(operator, { read: 'inbox.unattended' });
      expect(codeOf(listed)).toBe('applied');
      expect(JSON.stringify(listed)).toContain(ticket.id);
    });

    it('WF-1 a map write grant can rank a ticket beside another ticket of that map', async () => {
      const map = await w.create(owner, { title: 'rank map' }, { taskType: 'map' });
      const a = await w.create(owner, { title: 'rank neighbour' }, { parentId: map.id });
      const b = await w.create(owner, { title: 'rank target' }, { parentId: map.id });
      const writer = await w.member('map-ranker', ['read', 'write'], {
        kind: 'record',
        id: map.id,
      });
      expect(codeOf(await w.read(writer, { read: 'task.read', recordId: a.id }))).toBe('applied');
      expect(
        codeOf(
          await w.as(writer, {
            command: 'task.update',
            recordId: b.id,
            expectedRevision: await w.revisionOf(b.id),
            fields: { title: 'written under map grant' },
          }),
        ),
      ).toBe('applied');
      const answer = await w.as(writer, {
        command: 'task.rank',
        recordId: b.id,
        expectedRevision: await w.revisionOf(b.id),
        afterId: a.id,
      });
      expect(codeOf(answer)).toBe('applied');
    });

    it('WF-1 a map-only reader live board digest changes when its readable ticket changes', async () => {
      const map = await w.create(owner, { title: 'live map' }, { taskType: 'map' });
      const ticket = await w.create(owner, { title: 'live ticket' }, { parentId: map.id });
      const reader = await w.member('live-map-reader', ['read'], { kind: 'record', id: map.id });
      const before = await boardReach(w.db.app, w.business, reader.presented, reader.personId);
      must(
        await w.as(owner, {
          command: 'task.update',
          recordId: ticket.id,
          expectedRevision: await w.revisionOf(ticket.id),
          fields: { title: 'changed live ticket' },
        }),
        'update',
      );
      const after = await boardReach(w.db.app, w.business, reader.presented, reader.personId);
      expect(codeOf(await w.read(reader, { read: 'task.read', recordId: ticket.id }))).toBe(
        'applied',
      );
      expect(before).toBeDefined();
      expect(after).not.toBe(before);
    });

    // Security review 1, M1 (R/lane-scratch/PORT-B/P15F-security-1.md): task.decide is authorised
    // on the ticket itself, so a decide grant on its map decides nothing and attends nothing.
    it('WF-1 a decide grant on the map alone leaves a ticket decision unattended', async () => {
      const map = await w.create(owner, { title: 'decision map' }, { taskType: 'map' });
      const ticket = await w.create(owner, { title: 'decision ticket' }, { parentId: map.id });
      const decider = await w.member('map-only-decider', ['read', 'decide'], {
        kind: 'record',
        id: map.id,
      });
      expect(codeOf(await w.read(decider, { read: 'task.read', recordId: ticket.id }))).toBe(
        'applied',
      );
      const gate = randomUUID();
      const unattended = async () =>
        (
          await w.db.app.withBusiness(w.business, async (tx) => {
            await raiseInboxItem(tx, {
              recipientPersonId: decider.personId,
              subjectRecordId: ticket.id,
              reason: 'decision',
              fact: { kind: 'gate', id: gate },
            });
            return await readUnattended(tx, owner.personId);
          })
        ).map((item) => item.subjectRecordId);
      expect(await unattended()).toContain(ticket.id);
      await w.db.app.withBusiness(w.business, async (tx) => {
        await grantTo(tx, decider, 'decide', { kind: 'record', id: ticket.id });
      });
      expect(await unattended()).not.toContain(ticket.id);
    });

    // Sol round 1 proofs for PR #722 at 0f78988 (R/sol/PRV-oa-722-R1.md), assertions and interleavings as written.
    it('WF-1 an upgrade repairs frontier rows for tickets cancelled before the migration', async () => {
      const old = readFileSync('migrations/20261003001618_wayfinder_maps.sql', 'utf8');
      const start = old.indexOf(
        'create or replace function public.map_summary_refresh(p_map uuid)',
      );
      const end = old.indexOf(
        'revoke all on function public.map_summary_refresh(uuid) from public;',
        start,
      );
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      await w.db.admin.execute(old.slice(start, end));
      const migration = readFileSync(
        'migrations/20261004070410_wayfinder_frontier_cancelled.sql',
        'utf8',
      );
      const map = await w.create(
        owner,
        { title: 'map present before upgrade' },
        { taskType: 'map' },
      );
      const ticket = await w.create(
        owner,
        { title: 'cancelled before upgrade' },
        { parentId: map.id },
      );
      const state = await second.withBusiness(w.business, async (tx) => {
        const rows = await tx.query<{ id: string }>(
          `insert into records (business_id, id, record_type_id, data)
       select $1, gen_random_uuid(), id,
         '{"key":"cancelled","label":"Cancelled","machine_category":"cancelled","position":6000}'::jsonb
       from record_types where business_id = $1 and key = 'task_state' returning id`,
          [w.business],
        );
        const row = rows[0];
        if (row === undefined) throw new Error('cancelled state absent');
        return row.id;
      });
      must(
        await w.as(owner, {
          command: 'task.set_state',
          recordId: ticket.id,
          expectedRevision: await w.revisionOf(ticket.id),
          stateId: state,
        }),
        'cancel before upgrade',
      );
      expect(await w.read(owner, { read: 'map.frontier', recordId: map.id })).toMatchObject({
        ok: true,
        frontier: [{ id: ticket.id }],
      });
      // Apply the shipped upgrade without touching any map or ticket afterwards.
      await w.db.admin.execute(migration);
      expect(await w.read(owner, { read: 'map.frontier', recordId: map.id })).toMatchObject({
        ok: true,
        frontier: [],
      });
    });

    it('WF-1 person to person map ranking cannot write after its parent loses map authority', async () => {
      const map = await w.create(owner, { title: 'rank authority map' }, { taskType: 'map' });
      const neighbour = await w.create(owner, { title: 'rank neighbour' }, { parentId: map.id });
      const target = await w.create(owner, { title: 'rank target' }, { parentId: map.id });
      const writer = await w.member('ranker', ['write'], { kind: 'record', id: map.id });
      const revision = await w.revisionOf(target.id);
      let fired = false;
      const db = intercept(async (sql, parameters) => {
        if (
          fired ||
          !sql.includes('pg_advisory_xact_lock') ||
          parameters[0] !== `task.siblings:${w.business}:parent:${map.id}`
        )
          return;
        fired = true;
        must(
          await w.asOnSecond(owner, {
            command: 'task.set_type',
            recordId: map.id,
            expectedRevision: await w.revisionOf(map.id),
            taskType: 'task',
          }),
          'concurrent parent retype',
        );
      });
      const answer = await executeCommand(db, w.business, writer.presented, 'api', {
        command: 'task.rank',
        operationId: randomUUID(),
        recordId: target.id,
        expectedRevision: revision,
        afterId: neighbour.id,
      });
      expect(fired).toBe(true);
      expect(
        codeOf(
          await w.as(writer, {
            command: 'task.rank',
            recordId: target.id,
            expectedRevision: await w.revisionOf(target.id),
            afterId: neighbour.id,
          }),
        ),
      ).toBe('SCOPE_NOT_GRANTED');
      expect.soft(codeOf(answer)).toBe('SCOPE_NOT_GRANTED');
      expect(await w.revisionOf(target.id)).toBe(revision);
    });

    it('WF-1 person to person unattended reach cannot combine an old map placement with a later grant', async () => {
      await w.grant(owner, 'assign');
      const a = await w.create(owner, { title: 'former recipient map' }, { taskType: 'map' });
      const b = await w.create(owner, { title: 'unreachable recipient map' }, { taskType: 'map' });
      const ticket = await w.create(
        owner,
        { title: 'unattended moved ticket' },
        { parentId: a.id },
      );
      const recipient = await w.member('recipient', []);
      must(
        await w.as(owner, {
          command: 'task.assign',
          recordId: ticket.id,
          expectedRevision: await w.revisionOf(ticket.id),
          fields: { assignee: recipient.personId },
        }),
        'assign unreachable recipient',
      );
      let fired = false;
      const db = intercept(async (sql) => {
        if (fired || !sql.includes('as "mapId"')) return;
        fired = true;
        must(
          await w.asOnSecond(owner, {
            command: 'task.reparent',
            recordId: ticket.id,
            expectedRevision: await w.revisionOf(ticket.id),
            parentId: b.id,
          }),
          'move before granting',
        );
        await second.withBusiness(w.business, async (tx) => {
          await grantTo(tx, recipient, 'read', { kind: 'record', id: a.id });
        });
      });
      const racy = await db.withBusiness(
        w.business,
        async (tx) => await readUnattended(tx, owner.personId),
      );
      const current = await w.db.app.withBusiness(
        w.business,
        async (tx) => await readUnattended(tx, owner.personId),
      );
      expect(fired).toBe(true);
      expect(codeOf(await w.read(recipient, { read: 'task.read', recordId: ticket.id }))).toBe(
        'SCOPE_NOT_GRANTED',
      );
      expect(current.map((item) => item.subjectRecordId)).toContain(ticket.id);
      expect(racy.map((item) => item.subjectRecordId)).toContain(ticket.id);
    });

    it('WF-1 person to person live board digest excludes map tickets changed after grant revocation', async () => {
      const map = await w.create(owner, { title: 'revoked live map' }, { taskType: 'map' });
      const ticket = await w.create(owner, { title: 'live private ticket' }, { parentId: map.id });
      const stillReadable = await w.create(owner, { title: 'stream remains admitted' });
      const reader = await w.member('live-reader', ['read'], { kind: 'record', id: map.id });
      await second.withBusiness(w.business, async (tx) => {
        await grantTo(tx, reader, 'read', { kind: 'record', id: stillReadable.id });
      });
      const digestAfterRevocation = async (editPrivateTicket: boolean) => {
        let fired = false;
        const db = intercept(async (sql) => {
          if (fired || !sql.includes('select distinct e.scope_kind as kind')) return;
          fired = true;
          await second.withBusiness(w.business, async (tx) => {
            await tx.query(
              `update grants set revoked_at = greatest(now(), granted_at)
          where business_id = $1 and subject_id = $2 and scope_id = $3 and action = 'read'
            and revoked_at is null`,
              [w.business, reader.personId, map.id],
            );
          });
          if (editPrivateTicket) {
            must(
              await w.asOnSecond(owner, {
                command: 'task.update',
                recordId: ticket.id,
                expectedRevision: await w.revisionOf(ticket.id),
                fields: { title: 'private update after revocation' },
              }),
              'update after revoking map grant',
            );
          }
        });
        const digest = await boardReach(db, w.business, reader.presented, reader.personId);
        expect(fired).toBe(true);
        return digest;
      };
      const before = await digestAfterRevocation(false);
      const currentBefore = await boardReach(
        w.db.app,
        w.business,
        reader.presented,
        reader.personId,
      );
      await second.withBusiness(w.business, async (tx) => {
        await grantTo(tx, reader, 'read', { kind: 'record', id: map.id });
      });
      const after = await digestAfterRevocation(true);
      const currentAfter = await boardReach(
        w.db.app,
        w.business,
        reader.presented,
        reader.personId,
      );
      expect(codeOf(await w.read(reader, { read: 'task.read', recordId: ticket.id }))).toBe(
        'SCOPE_NOT_GRANTED',
      );
      expect(currentAfter).toBe(currentBefore);
      expect(after).toBe(before);
    });

    // Criterion 2 of the same review: the crossings for map-grant rank and the live board.
    async function clientMap(title: string): Promise<Made> {
      await w.grant(owner, 'share');
      const map = await w.create(owner, { title }, { taskType: 'map' });
      const client = randomUUID();
      await addClient(w.db.app, w.business, client, owner);
      must(
        await w.as(owner, {
          command: 'map.scope',
          recordId: map.id,
          expectedRevision: await w.revisionOf(map.id),
          client,
        }),
        'scope map to its client',
      );
      return map;
    }

    it('WF-1 business to business and client to client map-grant ranking cannot place beside another map', async () => {
      const x = await clientMap('client X map');
      const y = await clientMap('client Y map');
      const x1 = await w.create(owner, { title: 'client X first' }, { parentId: x.id });
      const x2 = await w.create(owner, { title: 'client X second' }, { parentId: x.id });
      const y1 = await w.create(owner, { title: 'client Y ticket' }, { parentId: y.id });
      const writer = await w.member('client-x-ranker', ['write'], { kind: 'record', id: x.id });
      const bea = await w.outsider('bravo-ranker');
      const bravoMap = await w.create(bea, { title: 'bravo map' }, { taskType: 'map' }, w.bravo);
      const bravoTicket = await w.create(
        bea,
        { title: 'bravo ticket' },
        { parentId: bravoMap.id },
        w.bravo,
      );
      const revisions = async () => [
        await w.revisionOf(x2.id),
        await w.revisionOf(y1.id),
        await w.revisionOf(bravoTicket.id, w.bravo),
      ];
      const unchanged = await revisions();
      const rank = async (who: Member, recordId: string, afterId: string, business = w.business) =>
        codeOf(
          await w.as(
            who,
            {
              command: 'task.rank',
              recordId,
              expectedRevision: await w.revisionOf(recordId, business),
              afterId,
            },
            business,
          ),
        );
      // Client to client: map X's grant reaches neither client Y's ticket as a neighbour nor as a target.
      expect(await rank(writer, x2.id, y1.id)).toBe('SCOPE_NOT_GRANTED');
      expect(await rank(writer, y1.id, x1.id)).toBe('SCOPE_NOT_GRANTED');
      // Business to business: neither business ranks beside the other's ticket.
      expect(await rank(writer, x2.id, bravoTicket.id)).toBe('SCOPE_NOT_GRANTED');
      expect(await rank(bea, bravoTicket.id, x1.id, w.bravo)).toBe('NOT_FOUND');
      expect(await revisions()).toStrictEqual(unchanged);
      // Control: the same grant ranks beside its own map's ticket.
      expect(await rank(writer, x2.id, x1.id)).toBe('applied');
    });

    it('WF-1 business to business and client to client live board digest ignores another map', async () => {
      const x = await clientMap('client X map');
      const y = await clientMap('client Y map');
      const x1 = await w.create(owner, { title: 'client X live' }, { parentId: x.id });
      const y1 = await w.create(owner, { title: 'client Y live' }, { parentId: y.id });
      const reader = await w.member('client-x-live', ['read'], { kind: 'record', id: x.id });
      const bea = await w.outsider('bravo-live');
      const bravoMap = await w.create(
        bea,
        { title: 'bravo live map' },
        { taskType: 'map' },
        w.bravo,
      );
      const bravoTicket = await w.create(
        bea,
        { title: 'bravo live ticket' },
        { parentId: bravoMap.id },
        w.bravo,
      );
      const digest = async () =>
        await boardReach(w.db.app, w.business, reader.presented, reader.personId);
      const update = async (who: Member, recordId: string, business = w.business) =>
        must(
          await w.as(
            who,
            {
              command: 'task.update',
              recordId,
              expectedRevision: await w.revisionOf(recordId, business),
              fields: { title: 'changed elsewhere' },
            },
            business,
          ),
          'update',
        );
      const before = await digest();
      expect(before).toBeDefined();
      // Client to client: client Y's map ticket moves nothing on client X's reader's board.
      await update(owner, y1.id);
      expect(await digest()).toBe(before);
      // Business to business: bravo's map ticket moves nothing either.
      await update(bea, bravoTicket.id, w.bravo);
      expect(await digest()).toBe(before);
      // Control: the reader's own map ticket does.
      await update(owner, x1.id);
      expect(await digest()).not.toBe(before);
    });
  },
);
