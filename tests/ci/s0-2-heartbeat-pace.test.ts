// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-2 heartbeats, paced (NATHAN-GLITCHTIP 4, ORCH47). The worker pings after
// every pass the API answered (5 s) and the forwarder after every pass (15 s),
// far beyond a free watcher's budget. `OPS_HEARTBEAT_EVERY_MS` sets the least
// time between two pings to one address; unset, every pass pings, as before. A
// failed ping starts no wait, so the next pass tries again.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createForwarder } from '../../apps/forwarder/forward.ts';
import { heartbeatEvery, paced } from '../../apps/worker/heartbeat.ts';
import { main as worker } from '../../apps/worker/main.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const HALF_HOUR = 1_800_000;
const A = 'https://beat.example.test/a';
const B = 'https://beat.example.test/b';

function clocked(outcome: 'sent' | 'failed' = 'sent') {
  let now = 0;
  const sent: string[] = [];
  const send = (address: string | undefined) => {
    sent.push(address ?? '');
    return Promise.resolve(outcome);
  };
  return {
    sent,
    at: (ms: number) => {
      now = ms;
    },
    beat: (every: number) => paced(every, send, () => now),
  };
}

describe('S0-2 heartbeats, paced: the least time between two pings to one address', () => {
  it('unset, every pass pings, as before', async () => {
    const clock = clocked();
    const beat = clock.beat(0);
    for (const ms of [0, 5_000, 10_000]) {
      clock.at(ms);
      // oxlint-disable-next-line no-await-in-loop -- one pass at a time
      await beat(A);
    }
    expect(clock.sent).toEqual([A, A, A]);
  });

  it('set, a pass inside the wait sends nothing, and the first pass after it pings', async () => {
    const clock = clocked();
    const beat = clock.beat(HALF_HOUR);
    const outcomes = [];
    for (const ms of [0, 5_000, HALF_HOUR - 1, HALF_HOUR, HALF_HOUR + 5_000]) {
      clock.at(ms);
      // oxlint-disable-next-line no-await-in-loop -- one pass at a time
      outcomes.push(await beat(A));
    }
    expect(outcomes).toEqual(['sent', 'not due', 'not due', 'sent', 'not due']);
    expect(clock.sent).toEqual([A, A]);
  });

  it('a failed ping starts no wait: the next pass tries again', async () => {
    const clock = clocked('failed');
    const beat = clock.beat(HALF_HOUR);
    await beat(A);
    clock.at(5_000);
    await beat(A);
    expect(clock.sent).toEqual([A, A]);
  });

  it('paces each address apart', async () => {
    const clock = clocked();
    const beat = clock.beat(HALF_HOUR);
    await beat(A);
    await beat(B);
    clock.at(5_000);
    await beat(A);
    await beat(B);
    expect(clock.sent).toEqual([A, B]);
  });
});

describe('S0-2 heartbeats, paced: the setting', () => {
  it('reads a whole number of milliseconds, and unset or empty as every pass', () => {
    expect(heartbeatEvery({})).toBe(0);
    expect(heartbeatEvery({ OPS_HEARTBEAT_EVERY_MS: '' })).toBe(0);
    expect(heartbeatEvery({ OPS_HEARTBEAT_EVERY_MS: '1800000' })).toBe(HALF_HOUR);
  });

  it('refuses anything else by the setting name', () => {
    for (const value of ['half an hour', '-5', '1.5', '1e6', ' 60']) {
      expect(heartbeatEvery({ OPS_HEARTBEAT_EVERY_MS: value })).toBe(
        'OPS_HEARTBEAT_EVERY_MS is not a whole number of milliseconds',
      );
    }
  });
});

describe('S0-2 heartbeats, paced: the worker and forwarder read the setting', () => {
  it('the worker refuses a malformed setting before it asks the API anything', async () => {
    const said: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((text: string) => {
      said.push(text);
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await worker(['--once'], {
        OPS_ASTRO_API_URL: 'http://127.0.0.1:1',
        OPS_ASTRO_BUSINESS: 'alpha',
        OPS_ASTRO_TOKEN: 'made-up-token',
        OPS_ASTRO_DELEGATION: 'made-up-delegation',
        OPS_HEARTBEAT_EVERY_MS: 'soon',
      });
      expect(code).toBe(2);
    } finally {
      process.stderr.write = write;
    }
    expect(said.join('')).toContain('OPS_HEARTBEAT_EVERY_MS');
  });

  it('the forwarder refuses a malformed setting by name', () => {
    const run = spawnSync(process.execPath, ['scripts/ops/forwarder.mjs', '--once'], {
      cwd: ROOT,
      env: {
        PATH: process.env['PATH'] ?? '',
        DATABASE_FORWARDER_URL: 'postgres://made-up@127.0.0.1:1/none',
        OPS_ERROR_SINK_DSN: 'https://made-up-key@example.test/7',
        OPS_ENVIRONMENT: 'staging',
        OPS_HEARTBEAT_EVERY_MS: 'soon',
      },
      encoding: 'utf8',
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('OPS_HEARTBEAT_EVERY_MS');
  });
});

// Proofs from the Opus review of 86f3ae0 (handbacks/STAGING-DEPLOY-review-86f3ae0.md), unchanged.
describe('S0-2 heartbeats, paced: a pass inside the wait, a clock gone back, a pace too long', () => {
  it('a paced forwarder pass inside the wait completes, it does not fail', async () => {
    let now = 0;
    const beat = paced(
      HALF_HOUR,
      () => Promise.resolve('sent'),
      () => now,
    );
    const database = { transaction: () => Promise.resolve({ handled: 0, dropped: 0 }) } as never;
    const forwarder = createForwarder({
      database,
      send: (() => Promise.resolve()) as never,
      where: 'staging' as never,
      root: '/',
      heartbeat: () => beat(A),
    });
    await expect(forwarder.once()).resolves.toEqual({ handled: 0, dropped: 0 });
    now = 15_000;
    await expect(forwarder.once()).resolves.toEqual({ handled: 0, dropped: 0 });
  });

  it('the wall clock stepping back does not hold a healthy heartbeat past the gap', async () => {
    let now = 10_000_000;
    let real = 0;
    const sentAt: number[] = [];
    const beat = paced(
      HALF_HOUR,
      () => {
        sentAt.push(real);
        return Promise.resolve('sent');
      },
      () => now,
    );
    await beat(A);
    now -= 600_000; // the clock steps back ten minutes
    for (let pass = 0; pass < 360; pass += 1) {
      now += 5_000;
      real += 5_000;
      // oxlint-disable-next-line no-await-in-loop -- one pass at a time
      await beat(A);
    }
    expect(sentAt.length).toBe(2);
  });

  it('a pace far beyond any monitor window is refused by name', () => {
    for (const value of ['1800000000', '9'.repeat(400)]) {
      expect(typeof heartbeatEvery({ OPS_HEARTBEAT_EVERY_MS: value })).toBe('string');
    }
  });
});
