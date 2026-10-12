// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest';
import { alertEvent, dsnTransport } from '../../apps/api/alerts/sink.ts';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]),
}));

afterEach(() => vi.unstubAllGlobals());

it('a sink hostname resolving to a private address cannot receive the sink key', async () => {
  const delivered: RequestInit[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    delivered.push(init);
    return new Response('{}', { status: 200 });
  });
  try {
    await dsnTransport('https://sol-canary@example.test/7')(alertEvent('test', 'staging'));
  } catch (cause) {
    expect(cause).toBeInstanceOf(Error);
  }
  expect(delivered, 'a hostname with a loopback answer gets no key or event').toEqual([]);
});
