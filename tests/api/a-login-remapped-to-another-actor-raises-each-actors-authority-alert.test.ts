// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAlerts, type SinkEvent } from '../../apps/api/alerts/sink.ts';
import { composeApi } from '../../apps/api/server.ts';
import { generateSealingPair } from '../../packages/core-records/src/custody/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { testSignIn } from '../support/sign-in.ts';
import { createApiFixture, authorised, tokenFor, post, ISSUER } from './fixture.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a login remapped to another actor',
  // eslint-disable-next-line max-lines-per-function -- one world, both commands
  () => {
    it.each(['secret.set', 'access.grant'] as const)(
      "raises each actor's own authority alert for %s",
      // eslint-disable-next-line max-lines-per-function -- one change, the remap, the second change
      async (command) => {
        const fixture = await createApiFixture('sol1501remap');
        try {
          const second = await enrol(fixture.db.app, fixture.business, 'second-custodian');
          await fixture.db.app.withBusiness(fixture.business, async (tx) => {
            for (const member of [fixture.member, second]) {
              // eslint-disable-next-line no-await-in-loop -- one transaction, one grant after another
              await grantTo(
                tx,
                member,
                'manage',
                { kind: 'business', id: null },
                false,
                command === 'secret.set' ? 'custody' : 'access',
              );
            }
          });
          const sent: SinkEvent[] = [];
          const alerts = createAlerts({
            where: 'staging',
            root: process.cwd(),
            send: (event) => {
              sent.push(event);
              return Promise.resolve();
            },
          });
          const api = composeApi({
            keys: {
              ...runtimeKeys({ ...fixture.environment }),
              custody: generateSealingPair('test/sol1501@1').key,
            },
            database: fixture.db.app,
            admin: fixture.db.admin,
            signIn: testSignIn(ISSUER),
            executeRead,
            alerts,
          }).app;
          const headers = authorised(await tokenFor(fixture.member.presented.subject));
          const body =
            command === 'secret.set'
              ? {
                  operationId: randomUUID(),
                  name: 'xero.client-secret',
                  value: 'sol-synthetic-value',
                }
              : {
                  operationId: randomUUID(),
                  holderId: second.personId,
                  collection: 'task',
                  action: 'read',
                };
          const path =
            command === 'secret.set' ? '/api/b/alpha/secret/set' : '/api/b/alpha/access/grant';
          const first = await post(api, path, body, headers);
          expect(first.status, JSON.stringify(first.body)).toBe(200);
          await alerts.settled();
          await fixture.db.admin.execute(
            'update public.person_logins set person_id = $2 where business_id = $1 and person_id = $3 and active',
            [fixture.business, second.personId, fixture.member.personId],
          );
          const next = await post(
            api,
            path,
            {
              ...body,
              ...(command === 'secret.set' ? { name: 'ads.token' } : { action: 'comment' }),
            },
            headers,
          );
          expect(next.status, JSON.stringify(next.body)).toBe(200);
          const rows = await fixture.db.admin.execute<{ actor_id: string; outcome: string }>(
            `select actor_id, outcome from public.audit_events where command = $2 and operation_id = $1 order by seq`,
            [body.operationId, command],
          );
          expect(rows.map((row) => row.outcome)).toEqual(['applied', 'applied']);
          expect(new Set(rows.map((row) => row.actor_id)).size).toBe(2);
          await alerts.settled();
          expect(
            sent.map((event) => event.tags['alert']),
            'two actual changes by distinct actors each need their authority alert',
          ).toEqual(['authority-changed', 'authority-changed']);
        } finally {
          await fixture.drop();
        }
      },
      120_000,
    );
  },
);
