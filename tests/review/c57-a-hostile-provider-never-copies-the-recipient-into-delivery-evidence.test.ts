// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-promise-executor-return, max-lines-per-function -- Sol's proofs kept whole: each test server starts and stops in a promise around its send */
//
// C57 (#2017): a hostile provider that knows the address cannot plant the recipient in delivery
// evidence, and an ordinary provider id is kept so delivery webhooks still find their send (Sol's
// PR #2160 proofs, kept whole).

import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { landEmailEvent } from '../../packages/core-custody/src/broker-email-hook.ts';
import {
  approved,
  attemptsOf,
  custodyListing,
  itemOf,
  noDatabase,
  on,
  raisedScene,
  send,
  useShepherdWorld,
  w,
} from './shepherd-world.ts';

useShepherdWorld('sol2160echo');

describe.skipIf(noDatabase)('C57 hostile provider canary', () => {
  it('C57 a hostile provider cannot copy a recipient local part into delivery logs', async () => {
    const { scene, raised } = await raisedScene();
    await approved('alpha', raised);
    const item = await itemOf(raised, scene.recipient.personId);
    let calls = 0;
    const server = createServer((request, response) => {
      void (async () => {
        const parts: Buffer[] = [];
        for await (const part of request) parts.push(Buffer.from(part));
        const body = JSON.parse(Buffer.concat(parts).toString('utf8')) as { to: string[] };
        calls += 1;
        // The provider already sees the address. Copy its identifying part
        // into the one field the broker keeps as delivery evidence.
        const id = (body.to[0] ?? '').split('@')[0];
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id }));
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no test server port');
    const original = w.provider;
    let hostile: Awaited<ReturnType<typeof custodyListing>> | undefined;
    try {
      w.provider = { ...original, origin: `http://127.0.0.1:${address.port}` };
      hostile = await custodyListing(['email']);
      w.provider = original;
      await send('alpha', item, hostile.broker);
      expect(calls).toBe(1);
      const local = (scene.recipient.address ?? '').split('@')[0] ?? '';
      expect(local.length > 0).toBe(true);
      // Boolean only: even this deliberate failing proof must not print the canary.
      expect(
        JSON.stringify(await attemptsOf(item)).includes(local),
        'recipient local part reached delivery evidence',
      ).toBe(false);
    } finally {
      w.provider = original;
      await hostile?.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('C57 an ordinary provider id stays correlatable for a recipient with an initial', async () => {
    const { scene, raised } = await raisedScene();
    await w.db.admin.execute(
      `update public.person_identifiers set value = 'a.user@example.test',
         observed_value = 'a.user@example.test'
       where person_id = $1 and kind = 'email'`,
      [scene.recipient.personId],
    );
    await approved('alpha', raised);
    const item = await itemOf(raised, scene.recipient.personId);
    const messageId = 'a1111111-1111-4111-8111-111111111111';
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: messageId }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no server port');
    const original = w.provider;
    let route: Awaited<ReturnType<typeof custodyListing>> | undefined;
    try {
      w.provider = { ...original, origin: `http://127.0.0.1:${address.port}` };
      route = await custodyListing(['email']);
      w.provider = original;
      expect(await send('alpha', item, route.broker)).toMatchObject({
        ok: true,
        state: 'accepted',
      });
      const landed = await landEmailEvent(w.db.app, [on('alpha').business], {
        id: 'hook-event-2160',
        type: 'email.delivered',
        messageId,
      });
      expect({ landed, last: (await attemptsOf(item)).at(-1)?.state }).toStrictEqual({
        landed: 'DELIVERED',
        last: 'delivered',
      });
    } finally {
      w.provider = original;
      await route?.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
