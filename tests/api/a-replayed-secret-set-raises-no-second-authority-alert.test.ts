// SPDX-License-Identifier: AGPL-3.0-only
//
// A secret set is an authority change, and the security alerts raise one
// alert for it at once. A caller whose answer is lost sends the same
// operation again under the same operation id; the register replays the
// stored answer and changes nothing. One change is one alert: the replay, and
// a duplicate that arrives while the first is still running, raise none.
// The duplicate case runs the server on a pool of several connections, and
// both posts are seen waiting at the operation's own lock, held on a third
// connection, before either goes on: the two are at the door at once.

import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createAlerts, type Alerts, type SinkEvent } from '../../apps/api/alerts/sink.ts';
import { composeApi } from '../../apps/api/server.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { generateSealingPair } from '../../packages/core-records/src/custody/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, type Held } from '../support/lock-wait-race.ts';
import { testSignIn } from '../support/sign-in.ts';
import {
  authorised,
  createApiFixture,
  ISSUER,
  post,
  tokenFor,
  type ApiFixture,
} from './fixture.ts';

const SET = '/api/b/alpha/secret/set';

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a replayed secret set raises no second authority alert',
  // eslint-disable-next-line max-lines-per-function -- one world, the two schedules that share it
  () => {
    let fixture: ApiFixture;
    let api: Hono;
    let wide: Database;
    let alerts: Alerts;
    let headers: Record<string, string>;
    const sent: SinkEvent[] = [];

    beforeAll(async () => {
      fixture = await createApiFixture('replayed_secret_alert');
      await fixture.db.app.withBusiness(fixture.business, async (tx) => {
        await grantTo(
          tx,
          fixture.member,
          'manage',
          { kind: 'business', id: null },
          false,
          'custody',
        );
      });
      alerts = createAlerts({
        where: 'staging',
        root: process.cwd(),
        send: (event) => {
          sent.push(event);
          return Promise.resolve();
        },
      });
      api = composeApi({
        keys: {
          ...runtimeKeys({ ...fixture.environment }),
          custody: generateSealingPair('test/replayed-secret@1').key,
        },
        database: (wide = connect(fixture.db.appUrl, { source: 'runtime', max: 4 })),
        admin: fixture.db.admin,
        signIn: testSignIn(ISSUER),
        executeRead,
        alerts,
      }).app;
      headers = authorised(await tokenFor(fixture.member.presented.subject));
    }, 120_000);

    afterAll(async () => {
      await wide?.close();
      await fixture?.drop();
    });

    const raised = async (): Promise<readonly unknown[]> => {
      await alerts.settled();
      return sent.splice(0).map((event) => event.tags['alert']);
    };

    const outcomes = async (operationId: string): Promise<readonly string[]> =>
      (
        await fixture.db.admin.execute<{ readonly outcome: string }>(
          `select outcome from public.audit_events
            where command = 'secret.set' and operation_id = $1 order by seq`,
          [operationId],
        )
      ).map((row) => row.outcome);

    it('a lost answer retried under its operation id is one change and one alert', async () => {
      const body = {
        operationId: randomUUID(),
        name: 'xero.client-secret',
        value: 'first-value-1',
      };
      const first = await post(api, SET, body, headers);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(await raised()).toEqual(['authority-changed']);

      // The answer was lost; the caller sends the same intent again.
      const retried = await post(api, SET, body, headers);
      expect(retried.status).toBe(200);
      expect(await outcomes(body.operationId)).toEqual(['applied', 'replayed']);
      expect(await raised(), 'a replay changes no authority').toEqual([]);
    });

    /** Holds the lock `enter` takes for one operation of the fixture's member. */
    const holdOperation = async (operationId: string): Promise<Held> => {
      const identity = createHash('sha256').update(operationId).digest('hex');
      const key = `operation:${fixture.business.toLowerCase()}:${fixture.member.actorId}:${identity}`;
      return await hold(fixture.db, async (execute) => {
        await execute('select pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
      });
    };

    const waitersOn = async (held: Held): Promise<number> => {
      const rows = await fixture.db.admin.execute<{ readonly n: number }>(
        `select count(*)::int as n from pg_stat_activity a
          where a.datname = current_database() and a.wait_event_type = 'Lock'
            and $1::int = any(pg_blocking_pids(a.pid))`,
        [held.pid],
      );
      return rows[0]?.n ?? 0;
    };

    it('two posts of one operation at once are one change and one alert', async () => {
      const body = { operationId: randomUUID(), name: 'ads.token', value: 'twice-value-2' };
      const held = await holdOperation(body.operationId);
      const both = Promise.all([post(api, SET, body, headers), post(api, SET, body, headers)]);
      try {
        let waiting = 0;
        for (let look = 0; look < 500 && waiting < 2; look += 1) {
          // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
          waiting = await waitersOn(held);
          // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
          if (waiting < 2) await delay(10);
        }
        expect(waiting, 'both posts wait at the operation lock').toBe(2);
      } finally {
        await held.letGo();
      }
      const answers = await both;
      expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
      expect(await outcomes(body.operationId)).toEqual(['applied', 'replayed']);
      expect(await raised(), 'the duplicate changed nothing').toEqual(['authority-changed']);
    });
  },
);
