// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AUTH_UPDATE_USER_PASSWORD, catalogue } from '../../packages/core-connectors/src/index.ts';
import { setLoginPassword } from '../../packages/core-custody/src/broker-login-password.ts';
import { brokerFor } from './c40-password-set-broker.ts';

it.each([
  ['operation concurrency', 1, 100],
  ['route ceiling', 64, 1],
  // oxlint-disable-next-line max-lines-per-function -- one provider, two resets, their cleanup
] as const)('reset dispatch respects its %s', async (_name, concurrency, ceiling) => {
  const folder = mkdtempSync(join(tmpdir(), 'reset-limits-'));
  const held: { response: ServerResponse; id: string }[] = [];
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- replaced by the promise below
  let firstSeen = () => {};
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- replaced by the promise below
  let secondSeen = () => {};
  const first = new Promise<void>((resolve) => {
    firstSeen = resolve;
  });
  const second = new Promise<void>((resolve) => {
    secondSeen = resolve;
  });
  let open = false;
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- kept beside the provider it answers for
  const finish = (response: ServerResponse, id: string) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id }));
  };
  const provider = createServer((request, response) => {
    const id = (request.url ?? '').split('/').at(-1) ?? '';
    request.resume();
    held.push({ response, id });
    if (held.length === 1) firstSeen();
    if (held.length === 2) secondSeen();
    if (open) finish(response, id);
  });
  await new Promise<void>((resolve) => {
    provider.listen(0, '127.0.0.1', resolve);
  });
  const address = provider.address();
  if (address === null || typeof address === 'string') throw new Error('no provider port');
  const { broker, custody } = await brokerFor(
    `http://127.0.0.1:${address.port}`,
    'made-up-key',
    folder,
  );
  const bounded = {
    ...broker,
    operations: catalogue([{ ...AUTH_UPDATE_USER_PASSWORD, concurrency, timeoutMs: 1500 }]),
    // oxlint-disable-next-line no-map-spread -- a copy, the broker's routes stay as they are
    routes: broker.routes.map((route) => ({ ...route, ceiling })),
  };
  const calls: Promise<unknown>[] = [];
  try {
    calls.push(setLoginPassword(bounded, randomUUID(), 'valid password one'));
    await first;
    calls.push(setLoginPassword(bounded, randomUUID(), 'valid password two'));
    await Promise.race([
      second,
      new Promise((resolve) => {
        setTimeout(resolve, 500);
      }),
    ]);
    expect(held.length, 'simultaneous provider calls while the first is still unanswered').toBe(1);
  } finally {
    open = true;
    for (const { response, id } of held) finish(response, id);
    await Promise.allSettled(calls);
    await custody.stop();
    await new Promise<void>((resolve) => {
      provider.close(() => resolve());
    });
    rmSync(folder, { recursive: true, force: true });
  }
});
