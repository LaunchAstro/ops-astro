// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-2: the error sink's key and events leave only for a public address. The
// sink's name is resolved once when an event is sent; if any address it
// resolves to is private, loopback, link-local, the metadata service or an
// IPv4 address inside IPv6, nothing is sent. Otherwise the event goes to the
// address that was checked, with no second lookup, and the name stays the TLS
// name the certificate is checked against. A hostile spelling of a private
// address is refused however it is written. The resolver and the connection
// are fakes: no DNS is asked and nothing leaves.

import { isIP } from 'node:net';
import { describe, expect, it } from 'vitest';
import { alertEvent, dsnTransport } from '../../apps/api/alerts/sink.ts';
import type {
  TransportAnswer,
  TransportRequest,
} from '../../packages/core-connectors/src/index.ts';

function world(answers: Readonly<Record<string, readonly string[]>>) {
  const asked: string[] = [];
  const sent: TransportRequest[] = [];
  return {
    asked,
    sent,
    resolve: async (host: string) => {
      asked.push(host);
      return await Promise.resolve(isIP(host) === 0 ? (answers[host] ?? []) : [host]);
    },
    post: async (request: TransportRequest): Promise<TransportAnswer> => {
      sent.push(request);
      return await Promise.resolve({
        kind: 'answer',
        status: 200,
        headers: {},
        body: new Uint8Array(),
      });
    },
  };
}

async function send(dsn: string, w: ReturnType<typeof world>): Promise<void> {
  await dsnTransport(dsn, w.resolve, w.post)(alertEvent('test', 'staging'));
}

describe('a sink name resolving to an address that is not public gets nothing', () => {
  for (const [what, addresses] of [
    ['loopback', ['127.0.0.1']],
    ['the metadata service', ['169.254.169.254']],
    ['a private network', ['10.0.0.8']],
    ['IPv4-mapped loopback', ['::ffff:127.0.0.1']],
    ['IPv6 loopback', ['::1']],
    ['one private among public ones', ['93.184.216.34', '192.168.1.4']],
    ['no address at all', []],
  ] as const) {
    it(what, async () => {
      const w = world({ 'example.test': addresses });
      await expect(send('https://canary@example.test/7', w)).rejects.toThrow(
        /^OPS_ERROR_SINK_DSN/u,
      );
      expect(w.asked).toEqual(['example.test']);
      expect(w.sent).toEqual([]);
    });
  }

  it('in mixed case with a trailing dot', async () => {
    const w = world({ 'example.test.': ['127.0.0.1'] });
    await expect(send('https://canary@Example.TEST./7', w)).rejects.toThrow(/^OPS_ERROR_SINK_DSN/u);
    expect(w.sent).toEqual([]);
  });
});

it('a private address however it is spelled gets nothing', async () => {
  const w = world({});
  for (const host of [
    '2130706433',
    '0x7f000001',
    '0177.0.0.1',
    '127.1',
    '0xa9.0xfe.0xa9.0xfe',
    '[::ffff:127.0.0.1]',
    '[::ffff:a9fe:a9fe]',
    'LOCALHOST.',
    '198.18.0.1',
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- each spelling is checked on its own
    await expect(send(`https://canary@${host}/7`, w), host).rejects.toThrow(/^OPS_ERROR_SINK_DSN/u);
  }
  expect(w.sent).toEqual([]);
});

it('a public sink gets the event at the address checked, its name kept for TLS', async () => {
  const w = world({ 'example.test': ['93.184.216.34', '2606:2800:220:1::1'] });
  await send('https://publickey@example.test/7', w);
  expect(w.asked).toEqual(['example.test']);
  expect(w.sent).toHaveLength(1);
  const [request] = w.sent;
  expect(request?.address).toBe('93.184.216.34');
  expect(request?.family).toBe(4);
  expect(request?.url.href).toBe('https://example.test/api/7/store/');
  expect(request?.method).toBe('POST');
  expect(request?.headers['x-sentry-auth']).toContain('sentry_key=publickey');
  expect(new TextDecoder().decode(request?.body)).not.toContain('publickey');
});

it('a sink that answers with a redirect or not at all is a failed send', async () => {
  for (const answer of [
    {
      kind: 'answer',
      status: 302,
      headers: { location: 'https://elsewhere.test/' },
      body: new Uint8Array(),
    },
    { kind: 'failed' },
  ] as const) {
    const w = world({ 'example.test': ['93.184.216.34'] });
    const post = async (request: TransportRequest) => {
      w.sent.push(request);
      return await Promise.resolve(answer);
    };
    // oxlint-disable-next-line no-await-in-loop -- each answer is checked on its own
    await expect(
      dsnTransport('https://k@example.test/7', w.resolve, post)(alertEvent('test', 'staging')),
    ).rejects.toThrow();
    expect(w.sent).toHaveLength(1);
  }
});
