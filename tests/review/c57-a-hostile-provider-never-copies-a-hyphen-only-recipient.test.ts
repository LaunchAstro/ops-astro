// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-promise-executor-return, max-lines-per-function -- Sol's proof kept whole: its test server starts and stops in a promise around the send */
//
// C57 (#2017): a hostile provider's schema-valid hyphen-only ID must not
// copy the recipient's whole local part into persisted delivery evidence (Sol's PR #2160
// proof, kept whole).

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

useShepherdWorld('sol2160dash');

describe.skipIf(noDatabase)('C57 hyphen-only recipient', () => {
  it('C57 a hostile provider cannot copy a hyphen-only recipient into delivery logs', async () => {
    const { scene, raised } = await raisedScene();
    await w.db.admin.execute(
      `update public.person_identifiers set value = '-----------------------@example.test',
         observed_value = '-----------------------@example.test'
       where person_id = $1 and kind = 'email'`,
      [scene.recipient.personId],
    );
    await approved('alpha', raised);
    const item = await itemOf(raised, scene.recipient.personId);
    const messageId = '-----------------------';
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
      expect(
        JSON.stringify(await attemptsOf(item)).includes(messageId),
        'recipient local part reached delivery evidence',
      ).toBe(false);
    } finally {
      w.provider = original;
      await route?.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
