// SPDX-License-Identifier: AGPL-3.0-only
//
// The Realtime carriage joins a private topic with one login's own token. A
// join that cannot be made (nothing answering at the Realtime address, or the
// server refusing it) is `CARRIAGE_UNAVAILABLE` within its join window, so the
// call is released having offered nothing; it is never left waiting. Whether
// a hosted project admits the join is the live probe's to show.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realtimeCarriage } from '../../packages/core-custody/src/index.ts';

const TOPIC =
  'carry:0b6f2a8e-1c3d-4e5f-8a9b-0c1d2e3f4a5b:call:7d2c9e41-5a6b-4c7d-8e9f-a0b1c2d3e4f5';

describe('a Realtime join that cannot be made', () => {
  let refusing: Server;
  let origin = '';

  beforeAll(async () => {
    // Answers every request, the WebSocket upgrade included, with a refusal.
    refusing = createServer((_request, response) => {
      response.writeHead(403).end();
    });
    await new Promise<void>((resolve) => {
      refusing.listen(0, '127.0.0.1', resolve);
    });
    origin = `http://127.0.0.1:${String((refusing.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    refusing.closeAllConnections();
    await new Promise<void>((resolve) => {
      refusing.close(() => resolve());
    });
  });

  it.each([
    ['a server that refuses it', () => `${origin.replace('http', 'ws')}/realtime/v1`],
    ['nothing at the address', () => 'ws://127.0.0.1:9/realtime/v1'],
  ])(
    'is unavailable within its window: %s',
    async (_name, url) => {
      const carriage = realtimeCarriage({
        url: url(),
        apiKey: 'publishable-test',
        joinTimeoutMs: 1_500,
      });
      const started = Date.now();
      const joined = await carriage.join(TOPIC, 'header.e30.signature');
      expect(joined).toStrictEqual({ ok: false, code: 'CARRIAGE_UNAVAILABLE' });
      expect(Date.now() - started).toBeLessThan(5_000);
    },
    15_000,
  );
});
