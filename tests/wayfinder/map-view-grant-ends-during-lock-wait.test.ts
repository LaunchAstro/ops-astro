// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one schedule, run once with an ending grant and once with a lasting one */
//
// `map.view` judges the reader's grant at the door, then waits for a share
// lock on the map row before it fetches the map's sections. A grant that
// ends during that wait must reach nothing: the read answers not-found, and no
// section, ticket or version is fetched after the lock is held.
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { Member } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, must, wayfinderWorld, type Made, type WayfinderWorld } from './world.ts';

const FOG = 'FOG-SEEN-ONLY-UNDER-A-LIVE-GRANT';
const CONTENT = /map_components|map_versions|uuid_4 = \$2|client/u;

const noop = (): void => undefined;

/** A promise and the call that settles it. */
function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open = noop;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** The app pool with every statement's text recorded, in order. */
function recording(pool: Database, seen: string[]): Database {
  return {
    ...pool,
    async withBusiness(businessId, run) {
      return await pool.withBusiness(businessId, async (tx) => {
        const wrapped: typeof tx = {
          ...tx,
          async query<Row>(sql: string, parameters: readonly unknown[] = []) {
            seen.push(sql);
            return await tx.query<Row>(sql, parameters);
          },
        };
        return await run(wrapped);
      });
    },
  };
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a map grant that ends while map.view waits for the map’s lock',
  () => {
    let w: WayfinderWorld;
    let writer: Database;
    let map: Made;

    beforeAll(async () => {
      w = await wayfinderWorld('mapwait', 'mapwait');
      writer = connect(w.db.appUrl, { source: 'runtime' });
      const owner = await w.decider('owner');
      map = await w.create(owner, { title: 'held map' }, { taskType: 'map' });
      must(
        await w.as(owner, {
          command: 'map.revise',
          recordId: map.id,
          expectedRevision: await w.revisionOf(map.id),
          addFog: [FOG],
        }),
        'add fog',
      );
    });

    afterAll(async () => {
      await writer.close();
      await w.drop();
    });

    /** A person whose one grant is read on the map, ending at `ends` or never. */
    async function readerOf(name: string, ends: Date | null): Promise<Member> {
      const reader = await w.member(name, []);
      await w.db.app.withBusiness(w.business, async (tx) => {
        const issued = await issueGrant(tx, [], {
          subject: { kind: 'person', id: reader.personId },
          scope: { kind: 'record', id: map.id },
          collection: 'task',
          action: 'read',
          parentGrantId: null,
          grantedByActorId: reader.actorId,
          expiresAt: ends,
        });
        if (!issued.ok) throw new Error(`grant refused ${issued.refusal.code}`);
      });
      return reader;
    }

    async function shareLockWaiting(): Promise<boolean> {
      const rows = await w.db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from pg_stat_activity
          where wait_event_type = 'Lock' and query ilike '%for share%'`,
      );
      return rows[0]?.n !== '0';
    }

    /**
     * The map row held by another transaction while `reader` calls map.view;
     * released once the reader is seen waiting and `ends` (if any) has passed.
     */
    async function readBehindTheLock(
      reader: Member,
      ends: Date | null,
    ): Promise<{ readonly answer: unknown; readonly afterLock: readonly string[] }> {
      const { wait: released, open: release } = gate();
      const { wait: held, open: locked } = gate();
      const holding = writer.withBusiness(w.business, async (tx) => {
        await tx.query(`select 1 from public.records where id = $1 for update`, [map.id]);
        locked();
        await released;
      });
      await held;
      const seen: string[] = [];
      const reading = executeRead(recording(w.db.app, seen), w.business, reader.presented, {
        read: 'map.view',
        recordId: map.id,
      } as never);
      const until = Date.now() + 10_000;
      // eslint-disable-next-line no-await-in-loop -- polled until the reader waits on the lock
      while (!(await shareLockWaiting())) {
        if (Date.now() > until) throw new Error('the reader never waited on the map lock');
        // eslint-disable-next-line no-await-in-loop -- as above
        await delay(25);
      }
      if (ends !== null) await delay(Math.max(0, ends.getTime() - Date.now()) + 250);
      release();
      await holding;
      const answer = await reading;
      const lockAt = seen.findIndex((sql) => /for share/u.test(sql));
      expect(lockAt).toBeGreaterThanOrEqual(0);
      return { answer, afterLock: seen.slice(lockAt + 1) };
    }

    it('serves the map to a grant that lasts through the wait', async () => {
      const reader = await readerOf('lasting', null);
      const { answer, afterLock } = await readBehindTheLock(reader, null);
      expect(codeOf(answer)).toBe('applied');
      expect(JSON.stringify(answer)).toContain(FOG);
      expect(afterLock.some((sql) => CONTENT.test(sql))).toBe(true);
    });

    it('answers not-found, and fetches nothing of the map, once the grant has ended', async () => {
      const ends = new Date(Date.now() + 1500);
      const reader = await readerOf('ending', ends);
      const { answer, afterLock } = await readBehindTheLock(reader, ends);
      expect(codeOf(answer)).toBe('NOT_FOUND');
      expect(JSON.stringify(answer)).not.toContain(FOG);
      expect(afterLock.filter((sql) => CONTENT.test(sql))).toEqual([]);
    });
  },
);
