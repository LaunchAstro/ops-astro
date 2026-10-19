// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-promise-executor-return -- Sol's proof kept whole: its test server starts and stops in a promise */
//
// C57 (#2017): a hostile provider that knows the address cannot plant the recipient in delivery
// evidence (Sol's PR #2160 proof, kept whole).

import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  approved,
  attemptsOf,
  custodyListing,
  itemOf,
  noDatabase,
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
});
