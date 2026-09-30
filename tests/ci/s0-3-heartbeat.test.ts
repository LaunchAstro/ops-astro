// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3 (lines C1 and C6) and S0-2: the scheduled jobs' heartbeats. A job that
// finished pings the off-box watcher; silence is the alert. The ping goes only
// to a public https address, follows no redirect, gives up after a limit, and
// answers in a word, so the address and the watcher's token in it are never
// printed. The watcher's side is `alerts.mjs plan` (tests/ci/s0-2-watcher.test.ts).

import { describe, expect, it } from 'vitest';
import { plainAlert } from '../../apps/api/alerts/catalogue.ts';
import { NOT_PLAIN } from './s0-2-plain.ts';

const MODULE = '../../scripts/ops/heartbeat.mjs';
const heartbeat = async () =>
  (await import(
    /* @vite-ignore */
    MODULE
  )) as {
    ping: (address: string | undefined, get?: typeof fetch) => Promise<string>;
    sinkAnswers: (dsn: string, get?: typeof fetch) => Promise<boolean>;
  };

const TOKEN = 'made-up-heartbeat-path';
const ADDRESS = `https://heartbeat.example.test/api/push/${TOKEN}`;

/** A fetch that answers `status` and keeps what it was asked. */
function answering(status: number) {
  const asked: { url: string; init: RequestInit | undefined }[] = [];
  const get = ((url: URL | string, init?: RequestInit) => {
    asked.push({ url: String(url), init });
    return Promise.resolve(
      new Response('ignored', { status, headers: { location: 'https://elsewhere.test/' } }),
    );
  }) as typeof fetch;
  return { get, asked };
}

describe('S0-3 heartbeat', () => {
  heartbeatCases1();
  heartbeatCases2();
  sinkCases();
});

function heartbeatCases1() {
  it('pings the address once, following no redirect and with a time limit, and says sent', async () => {
    const { ping } = await heartbeat();
    const { get, asked } = answering(200);
    expect(await ping(ADDRESS, get)).toBe('sent');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.url).toBe(ADDRESS);
    expect(asked[0]?.init?.redirect).toBe('manual');
    expect(asked[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(asked[0]?.init?.method ?? 'GET').toBe('GET');
  });

  it('a redirect, an error answer or a failed request is failed, and none is followed', async () => {
    const { ping } = await heartbeat();
    for (const status of [301, 302, 307, 404, 500]) {
      const { get, asked } = answering(status);
      // oxlint-disable-next-line no-await-in-loop
      expect(await ping(ADDRESS, get), String(status)).toBe('failed');
      expect(asked).toHaveLength(1);
    }
    const thrown = (async () => {
      throw new Error(`connect ECONNREFUSED ${ADDRESS}`);
    }) as typeof fetch;
    expect(await ping(ADDRESS, thrown)).toBe('failed');
  });

  it('an unset address is not set; one the watcher could not own is refused, never asked', async () => {
    const { ping } = await heartbeat();
    const { get, asked } = answering(200);
    expect(await ping(undefined, get)).toBe('not set');
    expect(await ping('', get)).toBe('not set');
    for (const address of [
      `http://heartbeat.example.test/${TOKEN}`,
      `https://127.0.0.1/${TOKEN}`,
      `https://localhost./${TOKEN}`,
      `https://10.0.0.8/${TOKEN}`,
      `https://169.254.169.254/${TOKEN}`,
      `https://[::1]/${TOKEN}`,
      `https://0x7f.0.0.1/${TOKEN}`,
      `https://m5.local/${TOKEN}`,
      'not a url',
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await ping(address, get), address).toBe('refused');
    }
    expect(asked).toStrictEqual([]);
  });
}

function heartbeatCases2() {
  it('answers in a word, so the address and its token never reach a record', async () => {
    const { ping } = await heartbeat();
    for (const status of [200, 500]) {
      // oxlint-disable-next-line no-await-in-loop
      const outcome = await ping(ADDRESS, answering(status).get);
      expect(['sent', 'failed']).toContain(outcome);
      expect(outcome).not.toContain(TOKEN);
    }
  });

  it('a stale restore is told in plain words: what broke, what it affects, what happens next', () => {
    const { title, text } = plainAlert(
      'restore-stale' as Parameters<typeof plainAlert>[0],
      'staging',
    );
    for (const pattern of NOT_PLAIN) {
      expect(title).not.toMatch(pattern);
      expect(text).not.toMatch(pattern);
    }
    expect(title).toMatch(/restore/iu);
    expect(text.split('\n')).toHaveLength(3);
  });
}

// S0-2 heartbeats: the error sink reports by heartbeat, sent from the machine
// (re-plan section 7, item 10). Its forwarder pings the sink's heartbeat only
// when the sink's own health page answers; the key in the DSN is never sent.
function sinkCases() {
  const DSN = 'https://made-up-sink-key@example.test/3';

  it('the error sink answers only when its health page does, asked without its key', async () => {
    const { sinkAnswers } = await heartbeat();
    const { get, asked } = answering(200);
    expect(await sinkAnswers(DSN, get)).toBe(true);
    expect(asked.map((a) => a.url)).toEqual(['https://example.test/_health/']);
    expect(asked[0]?.init?.redirect).toBe('manual');
    expect(asked[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    for (const status of [302, 500]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await sinkAnswers(DSN, answering(status).get), String(status)).toBe(false);
    }
    const thrown = (() => Promise.reject(new Error('connect ECONNREFUSED'))) as typeof fetch;
    expect(await sinkAnswers(DSN, thrown)).toBe(false);
  });
}
