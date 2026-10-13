// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createRealtimeDatabase } from '../support/realtime-database.ts';
import { carriageBusiness, callTopic } from './carriage-fixture.ts';
import { asIssued } from '../support/realtime-hub.ts';

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'the hosted policy suite reaches its admitted-send positive control',
  // oxlint-disable-next-line max-lines-per-function -- one database, a send by hand and the suite's own helper
  async () => {
    const db = await createRealtimeDatabase('policy_send_control');
    try {
      const world = await carriageBusiness(db.app, 'policysend');
      const topic = callTopic(world.id, world.callId);
      const send = async (claims: Record<string, unknown>) => {
        try {
          await db.admin.transaction(async (execute) => {
            await execute('set local role authenticated');
            await execute("select set_config('request.jwt.claims', $1, true)", [
              JSON.stringify(claims),
            ]);
            await execute("select set_config('realtime.topic', $1, true)", [topic]);
            await execute(
              `insert into realtime.messages (topic, extension, event, payload, private)
            values ($1, 'broadcast', 'piece', '{}'::jsonb, true)`,
              [topic],
            );
            throw new Error('sent');
          });
        } catch (cause) {
          const error = cause as { code?: string; message?: string };
          return error.message === 'sent' ? 'sent' : error.code;
        }
        return 'unknown';
      };
      expect(
        await send(asIssued({ sub: world.owner.sub })),
        'Control: a fresh sign-in is admitted',
      ).toBe('sent');
      // Execute the named suite's actual helper, so fixing its claims fixes this proof too.
      const source = readFileSync(
        new URL('./hosted-policies-call-the-one-join-function.test.ts', import.meta.url),
        'utf8',
      );
      const helper = source.match(/async function send\([\s\S]*?\n\}\n/u)?.[0];
      expect(helper).toBeDefined();
      const compiled = stripTypeScriptTypes(helper ?? '');
      const namedSend = new Function('asIssued', `${compiled}; return send;`)(asIssued) as (
        admin: typeof db.admin,
        topic: string,
        sub: string,
      ) => Promise<string>;
      expect(
        await namedSend(db.admin, topic, world.owner.sub),
        'The named suite omits amr and its positive control is refused before testing send access',
      ).toBe('sent');
    } finally {
      await db.drop();
    }
  },
  180_000,
);
