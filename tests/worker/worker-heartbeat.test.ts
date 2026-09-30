// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-2 heartbeats: the worker's own. A pass the API answered pings the
// worker's heartbeat; a pass with no answer, a fault or a refusal pings
// nothing, so a stopped or broken worker goes quiet and the watcher mails
// "Staging's worker did not check in on time". The API here is a fake on a
// loopback port, and the ping is a stand-in that keeps what it was asked:
// no real watcher is called. A heartbeat setting the watcher could never be
// is refused by name at start, before the API is asked, and never printed.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../apps/worker/main.ts';

const HEARTBEAT = 'https://heartbeat.example.test/api/push/made-up-worker-token';

let server: Server | undefined;
let asked = 0;

/** Closes the fake API, its kept-alive connections included. */
async function stop(): Promise<void> {
  server?.closeAllConnections();
  await new Promise((done) => {
    if (server === undefined) done(null);
    else server.close(done);
  });
  server = undefined;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await stop();
  asked = 0;
});

/** A fake API answering every call with `status`; its address. */
async function api(status: number): Promise<string> {
  server = createServer((request, response) => {
    asked += 1;
    request.resume();
    request.on('end', () => {
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ detail: { version: 1, gateId: 'gate' } }));
    });
  });
  await new Promise<void>((done) => {
    server?.listen(0, '127.0.0.1', done);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const settings = (url: string, heartbeat = HEARTBEAT) => ({
  OPS_ASTRO_API_URL: url,
  OPS_ASTRO_BUSINESS: 'alpha',
  OPS_ASTRO_TOKEN: 'made-up-worker-bearer',
  OPS_ASTRO_DELEGATION: 'made-up-delegation',
  OPS_WORKER_HEARTBEAT_URL: heartbeat,
  OPS_EGRESS_HEARTBEAT_HOST: 'heartbeat.example.test',
});

const quiet = (): string[] => {
  const written: string[] = [];
  const keep = (text: string | Uint8Array): boolean => {
    written.push(String(text));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(keep);
  vi.spyOn(process.stderr, 'write').mockImplementation(keep);
  return written;
};

describe('S0-2 heartbeats: the worker pings its own heartbeat', () => {
  it('after a pass the API answered, once, at its heartbeat address', async () => {
    quiet();
    const beats: (string | undefined)[] = [];
    const beat = (address: string | undefined) => {
      beats.push(address);
      return Promise.resolve('sent');
    };
    expect(await main(['--once'], settings(await api(200)), beat)).toBe(0);
    expect(beats).toEqual([HEARTBEAT]);
  });

  it('after a fault, a refusal or no answer, it pings nothing', async () => {
    quiet();
    for (const status of [500, 403]) {
      const beats: unknown[] = [];
      // oxlint-disable-next-line no-await-in-loop -- one fake API at a time
      await main(['--once'], settings(await api(status)), (address) => {
        beats.push(address);
        return Promise.resolve('sent');
      });
      expect(beats, String(status)).toEqual([]);
      // oxlint-disable-next-line no-await-in-loop -- closed before the next
      await stop();
    }
    const beats: unknown[] = [];
    await main(['--once'], settings('http://127.0.0.1:1'), (address) => {
      beats.push(address);
      return Promise.resolve('sent');
    });
    expect(beats).toEqual([]);
  });

  it('a heartbeat the watcher could never be is refused by name, before the API is asked', async () => {
    for (const bad of ['http://heartbeat.example.test/x', 'https://127.0.0.1/x', 'not a url']) {
      const written = quiet();
      // oxlint-disable-next-line no-await-in-loop -- one run at a time
      const code = await main(['--once'], settings(await api(200), bad), () =>
        Promise.resolve('sent'),
      );
      expect(code, bad).toBe(2);
      expect(written.join('')).toContain('OPS_WORKER_HEARTBEAT_URL');
      expect(written.join('').includes(bad), 'the value').toBe(false);
      expect(asked, 'the API was asked').toBe(0);
      vi.restoreAllMocks();
      // oxlint-disable-next-line no-await-in-loop -- closed before the next
      await stop();
    }
  });
});
