// SPDX-License-Identifier: AGPL-3.0-only
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createForwarder } from '../../apps/forwarder/forward.ts';
import type { SinkEvent } from '../../apps/api/alerts/sink.ts';
import { connectAsAdmin, type AdminConnection } from '../../packages/core-records/src/index.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { Client, loginIn } from './backup-identity.fixture.ts';

let db: FreshDatabase;
let login: { url: string; name: string };
let forwarderDb: AdminConnection;
const scope = 'ab'.repeat(32);

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'forwarder replay across batches',
  // eslint-disable-next-line max-lines-per-function -- one database and forwarder login shared by the replay cases
  () => {
    beforeAll(async () => {
      db = await createFreshDatabase({ part: 'solow071' });
      login = await loginIn(db, 'ops_astro_forwarder', 'fw');
      forwarderDb = connectAsAdmin(login.url, { source: 'forwarder' });
    }, 180_000);

    beforeEach(async () => {
      await db.admin.execute(
        'truncate ops.api_events, ops.api_alerts, ops.security_alert_log restart identity',
      );
    });

    afterAll(async () => {
      await forwarderDb?.close();
      await db?.drop();
      const cleanup = new Client(databaseUrlFromEnvironment() ?? '');
      try {
        if (login !== undefined) await cleanup.query(`drop role "${login.name}"`);
      } finally {
        await cleanup.end();
      }
    });

    function forward(events: SinkEvent[]) {
      return createForwarder({
        database: forwarderDb,
        send: (event) => Promise.resolve(void events.push(event)),
        where: 'staging',
        root: resolve(import.meta.dirname, '../..'),
      });
    }

    it('timestamp inversion across batches cannot count sign-ins outside the same window', async () => {
      // The database stamps now() at transaction start, whereas identity values
      // are allocated at insertion. Waiting transactions can invert these orders.
      // IDs 1..499 are unrelated and below their own thresholds.
      await db.admin.execute(`insert into ops.api_events (kind, scope)
      select 'export', lpad(to_hex(n), 64, '0') from generate_series(1, 499) n`);
      await db.admin.execute(
        `insert into ops.api_events (kind, scope, at)
      values ('sign-in-failed', $1, now())`,
        [scope],
      );
      await db.admin.execute(
        `insert into ops.api_events (kind, scope, at)
      select 'sign-in-failed', $1, now() - interval '16 minutes'
      from generate_series(1, 4)`,
        [scope],
      );
      const events: SinkEvent[] = [];
      expect(await forward(events).once()).toEqual({ handled: 504, dropped: 0 });
      expect(
        events.map((event) => event.tags['alert']),
        'four old sign-ins and one recent sign-in never form a five-sign-in burst',
      ).toEqual([]);
      const remaining = await db.admin.execute<{ n: number }>(
        "select count(*)::int as n from ops.api_events where kind = 'sign-in-failed'",
      );
      expect(remaining[0]?.n, 'the recent sign-in must remain available for its own burst').toBe(1);
    });

    it('replay retains a full sign-in burst across more than 10000 live scopes', async () => {
      await db.admin.execute(
        `insert into ops.api_events (kind, scope)
      select 'sign-in-failed', $1 from generate_series(1, 4)`,
        [scope],
      );
      await db.admin.execute(`insert into ops.api_events (kind, scope)
      select 'sign-in-failed', lpad(to_hex(n), 64, '0') from generate_series(1, 10000) n`);
      await db.admin.execute(
        `insert into ops.api_events (kind, scope)
      values ('sign-in-failed', $1)`,
        [scope],
      );
      const events: SinkEvent[] = [];
      const runner = forward(events);
      await runner.once();
      await runner.once();
      expect(
        events.map((event) => event.tags['alert']),
        'the five persisted sign-ins are all inside 15 minutes, including on retry',
      ).toEqual(['sign-in-failures']);
    });
  },
);
