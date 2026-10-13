// SPDX-License-Identifier: AGPL-3.0-only
//
// A gated send has one outcome. When its write is still going at the deadline,
// egress cuts it and answers `lapsed`; the write's own end callback runs after
// that cut, failed, and must not report the request written. A write that
// finishes in time reports written once and is never lapsed. The model here
// reads the request's head and then nothing, so the write cannot finish.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { startCustody } from '../../packages/core-custody/src/agent.ts';
import { parseDestinations, send } from '../../packages/core-custody/src/egress.ts';

/** Far more than loopback's socket buffers hold on either side. */
const LARGE = 32 * 1024 * 1024;
/** How long a late written note has to arrive after the answer. */
const LATE_MS = 200;

let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => {
    if (server === undefined) resolve();
    else server.close(() => resolve());
  });
  server = undefined;
});

/** A stand-in model: `stalled` takes the request's head and reads no more; otherwise it reads all and answers. */
async function model(stalled: boolean): Promise<{ origin: string; heard: () => boolean }> {
  let heard = false;
  server = createServer((request, response) => {
    heard = true;
    if (stalled) {
      request.pause();
      return;
    }
    request.resume();
    request.on('end', () => response.end('{}'));
  });
  const listening = server;
  await new Promise<void>((resolve) => {
    listening.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listening.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${String(port)}`, heard: () => heard };
}

const chat = (content: string): string => JSON.stringify({ messages: [{ role: 'user', content }] });

it('a write cut at its deadline answers lapsed and never reports written after it', async () => {
  const stalled = await model(true);
  const parsed = parseDestinations([{ key: 'ollama', origin: stalled.origin }]);
  if (!parsed.ok) throw new Error('the case listed a malformed destination');
  const written: number[] = [];
  const deadlineAt = Date.now() + 300;
  const outcome = await send(
    parsed.destinations,
    {
      destination: 'ollama',
      path: '/api/chat',
      method: 'POST',
      body: chat('x'.repeat(LARGE)),
      timeoutMs: 3_000,
      maxResponseBytes: 1024,
    },
    null,
    undefined,
    undefined,
    { deadlineAt, onWritten: () => written.push(Date.now()) },
  );
  expect(stalled.heard()).toBe(true);
  expect(outcome).toEqual({ ok: false, fault: 'lapsed', status: null });
  await sleep(LATE_MS);
  expect(written, `no written note after lapsed at deadline ${String(deadlineAt)}`).toEqual([]);
}, 10_000);

it('a write finished before its deadline reports written exactly once', async () => {
  const reading = await model(false);
  const parsed = parseDestinations([{ key: 'ollama', origin: reading.origin }]);
  if (!parsed.ok) throw new Error('the case listed a malformed destination');
  const written: number[] = [];
  const deadlineAt = Date.now() + 3_000;
  const outcome = await send(
    parsed.destinations,
    {
      destination: 'ollama',
      path: '/api/chat',
      method: 'POST',
      body: '{}',
      timeoutMs: 3_000,
      maxResponseBytes: 1024,
    },
    null,
    undefined,
    undefined,
    { deadlineAt, onWritten: () => written.push(Date.now()) },
  );
  expect(outcome.ok).toBe(true);
  expect(written).toHaveLength(1);
  expect(written[0]).toBeLessThan(deadlineAt);
});

it('custody’s own process never reports written for a request it refused as lapsed', async () => {
  const stalled = await model(true);
  const folder = mkdtempSync(join(tmpdir(), 'deadline-cut-'));
  const credentialsFile = join(folder, 'credentials.json');
  const none = { ref: 'ollama_key', kind: 'api_key', account: 'm5-ollama', destination: 'ollama' };
  writeFileSync(credentialsFile, JSON.stringify([{ ...none, scheme: 'none' }]), { mode: 0o600 });
  const custody = await startCustody({
    credentialsFile,
    destinations: [{ key: 'ollama', origin: stalled.origin }],
  });
  const written: number[] = [];
  try {
    const deadlineAt = Date.now() + 1_000;
    const outcome = await custody.dispatchBefore(
      'ollama_key',
      {
        destination: 'ollama',
        path: '/api/chat',
        method: 'POST',
        body: 'x'.repeat(LARGE),
        timeoutMs: 5_000,
        maxResponseBytes: 1024,
      },
      { deadlineAt, onWritten: () => written.push(Date.now()) },
    );
    expect(stalled.heard()).toBe(true);
    expect(outcome).toEqual({ kind: 'refused', started: false, code: 'SEND_LAPSED' });
    await sleep(LATE_MS);
    expect(
      written,
      `no written note for a refused request at deadline ${String(deadlineAt)}`,
    ).toEqual([]);
  } finally {
    await custody.stop();
    rmSync(folder, { recursive: true, force: true });
  }
}, 10_000);
