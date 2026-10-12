// SPDX-License-Identifier: AGPL-3.0-only
//
// The reset's place among its limits (`setLoginPassword`), raced in one
// process: resets that want the last place, a waiter whose deadline passes, a
// dispatch that throws, and one release waking many waiters. Custody is a
// stand-in that holds each call until the case answers it, so the count of
// calls with the provider at once is read, never inferred from timing. The
// last case is the real custody, refusing a call that is already past its
// window when there is room.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import {
  AUTH_UPDATE_USER_PASSWORD,
  authPasswordAdapter,
  catalogue,
} from '../../packages/core-connectors/src/index.ts';
import { setLoginPassword } from '../../packages/core-custody/src/broker-login-password.ts';
import type { Broker, Custody, CustodyOutcome } from '../../packages/core-custody/src/index.ts';
import { brokerFor } from '../api/c40-password-set-broker.ts';

interface Call {
  readonly id: string;
  readonly notAfter: number | undefined;
  answer(): void;
  fail(cause: Error): void;
}

interface Provider {
  readonly broker: Broker;
  /** Every call custody was handed, in order. */
  readonly calls: Call[];
  /** The most calls custody held unanswered at once. */
  readonly most: () => number;
  /** Waits until custody has been handed `count` calls in all. */
  readonly handed: (count: number) => Promise<void>;
}

/** A broker cataloguing the password update over `custody`, under `limit`. */
function brokerOver(
  custody: Custody,
  limit: { concurrency: number; ceiling: number; timeoutMs?: number },
): Broker {
  return {
    custody,
    operations: catalogue([
      {
        ...AUTH_UPDATE_USER_PASSWORD,
        concurrency: limit.concurrency,
        timeoutMs: limit.timeoutMs ?? 1500,
      },
    ]),
    providers: new Map([
      ['supabase_auth_password', { build: authPasswordAdapter, price: () => 0 }],
    ]),
    routes: [
      {
        key: 'auth',
        reach: 'cloud',
        provider: 'supabase_auth_password',
        credentialRef: 'auth_key',
        credentialKind: 'api_key',
        installation: 'here',
        ceiling: limit.ceiling,
      },
    ],
    installation: 'here',
    audit: async () => {
      await Promise.resolve();
    },
  };
}

/** A stand-in custody holding each call until it is answered, under `limit` at once. */
function standIn(limit: { concurrency: number; ceiling: number; timeoutMs?: number }): Provider {
  const calls: Call[] = [];
  let open = 0;
  let most = 0;
  const custody: Custody = {
    pid: process.pid,
    describe: async () => await Promise.resolve(null),
    stderr: () => '',
    raw: async () => await Promise.resolve({}),
    kill: () => {
      // No process to end.
    },
    stop: async () => await Promise.resolve(),
    dispatch: async (_ref, request) => {
      open += 1;
      most = Math.max(most, open);
      const id = request.path.split('/').at(-1) ?? '';
      try {
        return await new Promise<CustodyOutcome>((resolve, reject) => {
          calls.push({
            id,
            notAfter: request.notAfter,
            answer: () => {
              resolve({
                kind: 'answered',
                started: true,
                outbound: { ok: true, status: 200, body: JSON.stringify({ id }) },
                credentialKind: 'api_key',
                account: null,
              });
            },
            fail: reject,
          });
        });
      } finally {
        open -= 1;
      }
    },
  };
  const broker = brokerOver(custody, limit);
  const handed = async (count: number): Promise<void> => {
    for (let look = 0; look < 500 && calls.length < count; look += 1) {
      // oxlint-disable-next-line no-await-in-loop -- polls the stand-in, one look at a time
      await delay(5);
    }
    if (calls.length < count) throw new Error(`custody was handed ${calls.length}, not ${count}`);
  };
  return { broker, calls, most: () => most, handed };
}

/** Lets every timer and promise that is already due run, so a call that could go has gone. */
const settle = async (): Promise<void> => {
  await delay(100);
};

it('two resets racing for the last place reach the provider one at a time, the second after the first answers', async () => {
  const provider = standIn({ concurrency: 1, ceiling: 4 });
  const first = randomUUID();
  const second = randomUUID();
  const answers = [
    setLoginPassword(provider.broker, first, 'valid password one', Date.now() + 5_000),
    setLoginPassword(provider.broker, second, 'valid password two', Date.now() + 5_000),
  ];
  await provider.handed(1);
  await settle();
  expect(
    provider.calls.map((call) => call.id),
    'only the place holder is sent',
  ).toEqual([first]);
  provider.calls[0]?.answer();
  await provider.handed(2);
  provider.calls[1]?.answer();
  expect({ answers: await Promise.all(answers), most: provider.most() }).toEqual({
    answers: ['set', 'set'],
    most: 1,
  });
});

it('a reset whose deadline passes while it waits for room is a fault, never sent, and leaves the place count right', async () => {
  const provider = standIn({ concurrency: 4, ceiling: 1, timeoutMs: 300 });
  const holding = setLoginPassword(provider.broker, randomUUID(), 'valid password one');
  await provider.handed(1);
  const windowed = setLoginPassword(
    provider.broker,
    randomUUID(),
    'valid password two',
    Date.now() + 200,
  );
  // No window: its deadline is the operation's timeout.
  const timed = setLoginPassword(provider.broker, randomUUID(), 'valid password three');
  expect(await Promise.all([windowed, timed])).toEqual(['fault', 'fault']);
  expect(provider.calls, 'neither waiter reached custody').toHaveLength(1);
  provider.calls[0]?.answer();
  expect(await holding).toBe('set');
  // The two that gave up took no place: the next reset is sent at once.
  const next = setLoginPassword(provider.broker, randomUUID(), 'valid password four');
  await provider.handed(2);
  provider.calls[1]?.answer();
  expect({ next: await next, most: provider.most() }).toEqual({ next: 'set', most: 1 });
});

it('a reset whose dispatch throws gives its place back to the reset waiting for it', async () => {
  const provider = standIn({ concurrency: 1, ceiling: 1 });
  const thrown = setLoginPassword(provider.broker, randomUUID(), 'valid password one');
  await provider.handed(1);
  const waiting = setLoginPassword(
    provider.broker,
    randomUUID(),
    'valid password two',
    Date.now() + 5_000,
  );
  await settle();
  expect(provider.calls, 'the waiter waits while the first is out').toHaveLength(1);
  provider.calls[0]?.fail(new Error('custody lost its worker mid-call'));
  await expect(thrown).rejects.toThrow('custody lost its worker mid-call');
  await provider.handed(2);
  provider.calls[1]?.answer();
  expect({ waiting: await waiting, most: provider.most() }).toEqual({ waiting: 'set', most: 1 });
});

it('one release wakes every waiter and no more than the limit reach the provider at once', async () => {
  const provider = standIn({ concurrency: 2, ceiling: 4 });
  const ids = Array.from({ length: 7 }, () => randomUUID());
  const answers = ids.map(
    async (id, at) =>
      await setLoginPassword(provider.broker, id, `valid password ${at}`, Date.now() + 10_000),
  );
  for (let answered = 0; answered < ids.length; answered += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one answer at a time, each waking the waiters
    await provider.handed(Math.min(answered + 2, ids.length));
    // oxlint-disable-next-line no-await-in-loop -- one answer at a time, each waking the waiters
    await settle();
    expect(provider.calls.length, 'calls handed while the earlier ones are out').toBe(
      Math.min(answered + 2, ids.length),
    );
    provider.calls[answered]?.answer();
  }
  expect({
    answers: await Promise.all(answers),
    most: provider.most(),
    sent: provider.calls.map((call) => call.id).toSorted(),
  }).toEqual({ answers: ids.map(() => 'set'), most: 2, sent: ids.toSorted() });
});

it('a reset already past its window is not sent by custody even with room free', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'reset-past-window-'));
  let reached = 0;
  const loopback = createServer((request, response) => {
    reached += 1;
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: (request.url ?? '').split('/').at(-1) }));
  });
  await new Promise<void>((resolve) => {
    loopback.listen(0, '127.0.0.1', resolve);
  });
  const address = loopback.address();
  if (address === null || typeof address === 'string') throw new Error('no provider port');
  const { broker, custody } = await brokerFor(
    `http://127.0.0.1:${address.port}`,
    'made-up-key',
    folder,
  );
  try {
    const late = await setLoginPassword(broker, randomUUID(), 'valid password', Date.now() - 1);
    const live = await setLoginPassword(broker, randomUUID(), 'valid password', Date.now() + 5_000);
    expect({ late, live, reached }).toEqual({ late: 'fault', live: 'set', reached: 1 });
  } finally {
    await custody.stop();
    await new Promise<void>((resolve) => {
      loopback.close(() => resolve());
    });
    rmSync(folder, { recursive: true, force: true });
  }
});
