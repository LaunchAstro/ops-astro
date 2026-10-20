// SPDX-License-Identifier: AGPL-3.0-only
//
// The error sink's key and events go only to an address checked for that
// send: every answer the sink's name resolves to must be public, the
// connection is pinned to the checked one, and anything but a 2xx answer is a
// failed send. The carriage is a stand-in that keeps what it was handed;
// nothing here resolves a name or opens a socket.

import { describe, expect, it, vi } from 'vitest';
import { alertEvent, dsnTransport } from '../../apps/api/alerts/sink.ts';
import { carriage } from './s0-2-alerts.fixture.ts';

describe('the sink key goes only to a checked public address', () => {
  it('refuses a public sink name that resolves to a private address, before the key or an event leaves', async () => {
    const local = ['10.0.0.8', '169.254.169.254', '::1', '::ffff:127.0.0.1'];
    const notGlobal = ['3fff::1', '5f00::1', '100:0:0:1::1', '4000::1'];
    for (const answers of [...[...local, ...notGlobal].map((one) => [one]), []]) {
      const sink = carriage(answers);
      const send = dsnTransport('https://canary@example.test/7', sink);
      // oxlint-disable-next-line no-await-in-loop -- each answer is checked independently
      await expect(send(alertEvent('test', 'staging')), answers.join()).rejects.toThrow(
        /not a public address/u,
      );
      expect(sink.carried, answers.join()).toEqual([]);
    }
  });

  it('refuses a name whose answers mix a public and a private address', async () => {
    const sink = carriage(['93.184.215.14', '127.0.0.1']);
    const send = dsnTransport('https://canary@example.test/7', sink);
    await expect(send(alertEvent('test', 'staging'))).rejects.toThrow(/not a public address/u);
    expect(sink.carried).toEqual([]);
  });

  it('connects only to the address it checked, the name kept for the certificate', async () => {
    const sink = carriage(['93.184.215.14']);
    await dsnTransport('https://canary@example.test/7', sink)(alertEvent('test', 'staging'));
    expect(sink.carried.map((r) => [r.url.hostname, r.address, r.family])).toEqual([
      ['example.test', '93.184.215.14', 4],
    ]);
    expect(sink.carried[0]?.timeoutMs).toBeGreaterThan(0);
    expect(sink.carried[0]?.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it('checks the name again on every send, so a rebinding answer is refused', async () => {
    const sink = carriage(['93.184.215.14']);
    const rebinding = { ...sink, resolve: rebindsTo(['93.184.215.14'], ['127.0.0.1']) };
    const send = dsnTransport('https://canary@example.test/7', rebinding);
    await send(alertEvent('test', 'staging'));
    await expect(send(alertEvent('test', 'staging'))).rejects.toThrow(/not a public address/u);
    expect(sink.carried.map((r) => r.address)).toEqual(['93.184.215.14']);
  });
});

describe('a sink send succeeds only on a 2xx answer, in time', () => {
  it('fails the send on every answer that is not one, the socket landing off the pin included', async () => {
    for (const kind of ['address_changed', 'timeout', 'oversized', 'failed'] as const) {
      const send = dsnTransport('https://canary@example.test/7', {
        resolve: () => Promise.resolve(['93.184.215.14']),
        carry: () => Promise.resolve({ kind }),
      });
      // oxlint-disable-next-line no-await-in-loop -- each outcome is checked independently
      await expect(send(alertEvent('test', 'staging')), kind).rejects.toThrow(kind);
    }
  });

  it('a lookup that never answers ends the send at its deadline, and a late answer sends nothing', async () => {
    vi.useFakeTimers();
    try {
      let answer: ((addresses: readonly string[]) => void) | undefined;
      const sink = carriage([]);
      const late = {
        ...sink,
        resolve: () =>
          new Promise<readonly string[]>((done) => {
            answer = done;
          }),
      };
      const sent = dsnTransport(
        'https://canary@example.test/7',
        late,
      )(alertEvent('test', 'staging'));
      const settled = expect(sent).rejects.toThrow('did not answer in time');
      await vi.advanceTimersByTimeAsync(10_000);
      await settled;
      answer?.(['93.184.215.14']);
      await vi.advanceTimersByTimeAsync(1);
      expect(sink.carried).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not follow a sink redirect with the key and event', async () => {
    const sink = carriage(['93.184.215.14'], 302);
    const send = dsnTransport('https://canary@example.test/7', sink);
    await expect(send(alertEvent('test', 'staging'))).rejects.toThrow(
      'the error sink answered 302',
    );
    expect(sink.carried).toHaveLength(1);
  });
});

/** A resolver whose answers change between lookups, as a rebinding name's do. */
function rebindsTo(...answers: (readonly string[])[]) {
  let asked = 0;
  return () => Promise.resolve(answers[Math.min(asked++, answers.length - 1)] ?? []);
}
