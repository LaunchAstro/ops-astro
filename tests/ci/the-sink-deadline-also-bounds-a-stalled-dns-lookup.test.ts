// SPDX-License-Identifier: AGPL-3.0-only
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { alertEvent, dsnTransport } from '../../apps/api/alerts/sink.ts';

const dns = vi.hoisted(() => ({ hangs: false }));
vi.mock('node:dns/promises', () => ({
  lookup: async () =>
    dns.hangs ? await new Promise<never>(() => {}) : [{ address: '127.0.0.1', family: 4 }],
}));
afterEach(() => vi.unstubAllGlobals());

it('a private DNS answer never receives the sink key', async () => {
  dns.hangs = false;
  const transmitted: unknown[] = [];
  vi.stubGlobal('fetch', (...args: unknown[]) => {
    transmitted.push(args);
    return Promise.resolve(new Response('{}'));
  });
  let rejected = false;
  await dsnTransport('https://synthetic-key@example.test/7')(alertEvent('test', 'staging')).catch(
    () => {
      rejected = true;
    },
  );
  expect(transmitted, 'a private resolution must prevent transmission').toEqual([]);
  expect(rejected).toBe(true);
});

it('the sink deadline also bounds a stalled DNS lookup', async () => {
  dns.hangs = true;
  // Before this change fetch owns DNS and receives the ten-second signal.
  // Honour that signal without making a connection on either tree.
  vi.stubGlobal(
    'fetch',
    async (_url: unknown, init: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init.signal!;
        if (signal.aborted) reject(new Error('timed out'));
        else signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true });
      }),
  );
  let outcome = 'pending';
  void dsnTransport('https://synthetic-key@example.test/7')(alertEvent('test', 'staging')).then(
    () => void (outcome = 'sent'),
    () => void (outcome = 'failed'),
  );
  await delay(10_250);
  expect(
    outcome,
    'the ten-second send deadline must include DNS, before the connection opens',
  ).toBe('failed');
}, 20_000);
