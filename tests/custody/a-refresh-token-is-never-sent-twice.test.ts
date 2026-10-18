// SPDX-License-Identifier: AGPL-3.0-only
//
// #1620 P1 proof 3 (F1): a durable `pending` precedes the one refresh request,
// and a pending record is never sent again. The stage the request reached, not
// an error code, decides whether it was sent: only a failure before `carrying`
// restores `ready`.

import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import {
  tokenHolder,
  type TokenHolderOptions,
} from '../../packages/core-custody/src/plan-token.ts';
import { type TokenFile } from '../../packages/core-custody/src/token-file.ts';
import { startIssuer, type Issuer } from './fixtures/plan-issuer.ts';
import {
  HOUR,
  T0,
  faultyFs,
  fileBytes,
  holderInChild,
  runChild,
  seed,
  tempDir,
  sleep,
  tokens,
} from './fixtures/plan-token-world.ts';

let issuer: Issuer;
beforeAll(async () => {
  issuer = await startIssuer();
});
afterAll(() => issuer.close());
const worlds: { done(): void }[] = [];
afterEach(() => {
  issuer.onRequest(() => {});
  for (const w of worlds.splice(0)) w.done();
});

const due: TokenFile = { state: 'ready', tokens: tokens('old', T0 + 4 * 60_000) };
const rotated = {
  access_token: 'synthetic-access-new',
  refresh_token: 'synthetic-refresh-new',
  expires_in: 3_600,
};
async function start(): Promise<{ file: string; before: number }> {
  const w = tempDir();
  worlds.push(w);
  await seed(w.file, due);
  issuer.set({ kind: 'json', status: 200, body: rotated });
  return { file: w.file, before: issuer.count() };
}
const holder = (file: string, extra: Partial<TokenHolderOptions> = {}) =>
  tokenHolder({ file, tokenUrl: issuer.url, now: () => T0, ...extra });
const state = (file: string) => /^\{"state":"(\w+)"/u.exec(fileBytes(file).toString('latin1'))?.[1];

it('a failed pending write sends nothing, then a restart and a second live holder send nothing (0 requests)', async () => {
  const { file, before } = await start();
  const live = holder(file, { fs: faultyFs({ step: 'file-fsync', on: 'pending' }) });
  expect(await live.prepare()).toEqual({ ok: false, code: 'SUBSCRIPTION_STORE_FAILED' });
  expect(state(file)).toBe('ready');
  expect(issuer.count() - before).toBe(0);
  const second = await holderInChild(file, issuer.url, T0, { step: 'file-fsync', on: 'pending' });
  expect(second.prepare).toBe('SUBSCRIPTION_STORE_FAILED');
  expect(issuer.count() - before).toBe(0);
}, 20_000);

it('an answered refresh whose ready commit fails is not sent again by a restart or a second holder (1 request)', async () => {
  const { file, before } = await start();
  expect(await holder(file, { fs: faultyFs({ step: 'rename', on: 'ready' }) }).prepare()).toEqual({
    ok: false,
    code: 'SUBSCRIPTION_STORE_FAILED',
  });
  for (let i = 0; i < 2; i += 1)
    // oxlint-disable-next-line no-await-in-loop -- each step must finish before the next, in order
    expect((await holderInChild(file, issuer.url, T0)).prepare).toBe('SUBSCRIPTION_SIGN_IN_NEEDED');
  expect(issuer.count() - before).toBe(1);
}, 20_000);

it('a holder killed after pending leaves pending, and nothing is sent later', async () => {
  const { file, before } = await start();
  issuer.set({ kind: 'stall' });
  const writer = runChild({ op: 'prepare', file, tokenUrl: issuer.url.href, at: T0 });
  // oxlint-disable-next-line no-await-in-loop -- each step must finish before the next, in order
  while (issuer.count() === before) await sleep(10);
  writer.child.kill('SIGKILL');
  await writer.exited();
  issuer.set({ kind: 'json', status: 200, body: rotated });
  expect(state(file)).toBe('pending');
  expect((await holderInChild(file, issuer.url, T0)).prepare).toBe('SUBSCRIPTION_SIGN_IN_NEEDED');
  expect(issuer.count() - before).toBe(1);
}, 20_000);

const ambiguous = [
  ['a reset after reading the request', { kind: 'reset' }],
  ['a 429', { kind: 'json', status: 429, body: {} }],
  ['a 503', { kind: 'json', status: 503, body: {} }],
  ['a 302', { kind: 'json', status: 302, body: {} }],
] as const;
it.each(ambiguous)('%s leaves pending (1 request, then 0)', async (_name, mode) => {
  const { file, before } = await start();
  issuer.set(mode);
  expect(await holder(file).prepare()).toEqual({
    ok: false,
    code: 'SUBSCRIPTION_SIGN_IN_NEEDED',
  });
  expect(state(file)).toBe('pending');
  expect(await holder(file).prepare()).toEqual({
    ok: false,
    code: 'SUBSCRIPTION_SIGN_IN_NEEDED',
  });
  expect(issuer.count() - before).toBe(1);
});

it('a 30 s stall is aborted at the prepare deadline and leaves pending (1, then 0)', async () => {
  const { file, before } = await start();
  let at = T0;
  issuer.set({ kind: 'stall' });
  issuer.onRequest(() => {
    at += 31_000;
  });
  expect(await holder(file, { now: () => at }).prepare()).toEqual({
    ok: false,
    code: 'SUBSCRIPTION_SIGN_IN_NEEDED',
  });
  expect(state(file)).toBe('pending');
  expect(await holder(file, { now: () => at }).prepare()).toEqual({
    ok: false,
    code: 'SUBSCRIPTION_SIGN_IN_NEEDED',
  });
  expect(issuer.count() - before).toBe(1);
});

async function rawServer(onSocket: (s: import('node:net').Socket) => void): Promise<Server> {
  const server = createServer(onSocket);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

it('an https URL to a server that answers bytes that are not TLS fails in handshaking: not_sent, ready restored', async () => {
  const { file, before } = await start();
  const server = await rawServer((s) => s.end('synthetic plain bytes, not TLS\r\n\r\n'));
  const port = (server.address() as AddressInfo).port;
  const original = fileBytes(file);
  const out = await holder(file, {
    tokenUrl: new URL(`https://127.0.0.1:${port}/token`),
  }).prepare();
  server.close();
  expect(out).toEqual({ ok: false, code: 'SUBSCRIPTION_REFRESH_FAILED' });
  expect(fileBytes(file).equals(original)).toBe(true);
  expect(state(file)).toBe('ready');
  expect(issuer.count() - before).toBe(0);
  expect(await holder(file).prepare()).toEqual({ ok: true });
  expect(issuer.count() - before).toBe(1);
});

it('a closed loopback port fails in connecting: not_sent, ready restored', async () => {
  const { file } = await start();
  const server = await rawServer(() => {});
  const port = (server.address() as AddressInfo).port;
  await new Promise((resolve) => {
    server.close(resolve);
  });
  const out = await holder(file, { tokenUrl: new URL(`http://127.0.0.1:${port}/token`) }).prepare();
  expect(out).toEqual({ ok: false, code: 'SUBSCRIPTION_REFRESH_FAILED' });
  expect(state(file)).toBe('ready');
});

it('a deadline that passes as the connection completes lets no request byte reach the socket: not_sent, ready restored', async () => {
  const { file } = await start();
  let received = 0;
  const open: Socket[] = [];
  const server = await rawServer((s) => {
    open.push(s);
    s.on('data', (chunk: Buffer) => (received += chunk.length));
  });
  const port = (server.address() as AddressInfo).port;
  let at = T0;
  // Runs before the holder's own listeners on the same socket: the clock
  // passes the deadline at the instant the socket can first carry bytes.
  const onSocket = (message: unknown): void => {
    (message as { socket: Socket }).socket.once('connect', () => {
      at = T0 + 31_000;
    });
  };
  subscribe('net.client.socket', onSocket);
  try {
    const out = await holder(file, {
      tokenUrl: new URL(`http://127.0.0.1:${port}/token`),
      now: () => at,
    }).prepare();
    await sleep(100);
    expect(out).toEqual({ ok: false, code: 'SUBSCRIPTION_REFRESH_FAILED' });
    expect(state(file)).toBe('ready');
    expect(received, 'no header or body byte may leave after the deadline').toBe(0);
  } finally {
    unsubscribe('net.client.socket', onSocket);
    for (const s of open) s.destroy();
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }
});

it('a deadline that lapses during the lock wait sends nothing and leaves ready', async () => {
  const { file, before } = await start();
  const blocker = runChild({
    op: 'hold',
    file,
    id: 'b',
    log: `${file}.holds`,
    ms: -1,
    deadlineMs: 5_000,
  });
  await blocker.next();
  let at = T0;
  const ticking = setInterval(() => (at += 5_000), 20);
  const out = await holder(file, { now: () => at }).prepare();
  clearInterval(ticking);
  blocker.child.send('release');
  await blocker.exited();
  expect(out.ok).toBe(false);
  expect(state(file)).toBe('ready');
  expect(issuer.count() - before).toBe(0);
}, 20_000);

it('healthy: a normal rotation across a faked expiry, then a second holder presents it with no request', async () => {
  const w = tempDir();
  worlds.push(w);
  await seed(w.file, { state: 'ready', tokens: tokens('old', T0 + HOUR) });
  issuer.set({ kind: 'json', status: 200, body: rotated });
  const before = issuer.count();
  let at = T0;
  const live = holder(w.file, { now: () => at });
  expect(await live.prepare()).toEqual({ ok: true });
  expect(issuer.count() - before).toBe(0);
  at = T0 + HOUR - 5 * 60_000;
  expect(await live.prepare()).toEqual({ ok: true });
  expect(live.present()).toEqual({ ok: true, accessToken: 'synthetic-access-new' });
  expect((await holderInChild(w.file, issuer.url, at)).present).toBe('ok:synthetic-access-new');
  expect(issuer.count() - before).toBe(1);
}, 20_000);
