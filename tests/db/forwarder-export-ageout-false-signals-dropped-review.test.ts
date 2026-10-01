// SPDX-License-Identifier: AGPL-3.0-only
//
// Review proof (REVIEW-MAIN-B1 p02-1, red on d25e97e02). The export rule's
// window (detect.ts RULES.export, 60 minutes) equals the forwarder's
// retention window (forward.ts WINDOW_MS). Each pass first deletes rows older
// than WINDOW_MS as "dropped" and raises `signals-dropped`, and only then lets
// replay clear the signals past their rule's window. An export row under the
// threshold (every ordinary read that hands out records writes one) is never
// past its window at replay before the stale sweep takes it, so a forwarder
// that ran every pass still tells the owner it dropped signals it did not
// handle in time.

import { setTimeout } from 'node:timers/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SinkEvent } from '../../apps/api/alerts/sink.ts';
import { createForwarder } from '../../apps/forwarder/forward.ts';
import { connectAsAdmin, type AdminConnection } from '../../packages/core-records/src/index.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { Client, loginIn } from './backup-identity.fixture.ts';

const ROOT = resolve(import.meta.dirname, '../..');

let db: FreshDatabase;
let login: { url: string; name: string } | undefined;
let forwarderDb: AdminConnection;

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'p02-1: an export signal under its threshold ages out without a false signals-dropped alert',
  () => {
    beforeAll(async () => {
      db = await createFreshDatabase({ part: 'p02a' });
      login = await loginIn(db, 'ops_astro_forwarder', 'fw');
      forwarderDb = connectAsAdmin(login.url, { source: 'forwarder' });
    }, 180_000);

    afterAll(async () => {
      await forwarderDb?.close();
      await db?.drop();
      const cleanup = new Client(databaseUrlFromEnvironment() ?? '');
      await cleanup
        .query(`drop role if exists "${login?.name ?? 'none'}"`)
        .finally(() => cleanup.end());
    });

    it('a forwarder running every pass raises no signals-dropped for an ordinary read row', async () => {
      // One ordinary read: ten records handed out, far under the 5000 threshold,
      // two seconds short of the export window.
      await db.admin.execute(
        `insert into ops.api_events (kind, scope, weight, at)
           values ('export', $1, 10, now() - interval '3598 seconds')`,
        ['ab'.repeat(32)],
      );
      const events: SinkEvent[] = [];
      const forward = createForwarder({
        database: forwarderDb,
        send: (event) => Promise.resolve(void events.push(event)),
        where: 'staging',
        root: ROOT,
      });
      const alerts = (): string[] =>
        events.filter((event) => event.level === 'warning').map((e) => e.tags['alert'] ?? '');

      // Pass one: the row is inside its window, kept, nothing said.
      expect(await forward.once()).toEqual({ handled: 1, dropped: 0 });
      expect(alerts()).toEqual([]);

      // The next passes, a few seconds on: the forwarder never stopped.
      await setTimeout(3000);
      const second = await forward.once();
      expect(
        alerts(),
        'p02-1 false signals-dropped: an export row under threshold is dropped by the stale sweep, not cleared by its window',
      ).toEqual([]);
      expect(second.dropped, 'p02-1: the row was counted as dropped').toBe(0);
    });
  },
);
