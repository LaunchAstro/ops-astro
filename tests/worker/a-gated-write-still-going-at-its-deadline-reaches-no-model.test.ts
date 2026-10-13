// SPDX-License-Identifier: AGPL-3.0-only
//
// The send deadline bounds the whole write, not only its start. Custody
// checks the clock when the socket connects and then writes; a request too
// large for the socket's buffers, sent to a model that is slow to read it,
// is still being written after the deadline. Once the deadline passes the
// function's send fence lets its locks go, so every byte still unwritten
// then would reach the model after an ending could commit. A write not
// finished by the deadline must be cut, so the model never holds the whole
// request, and the write is never reported after the deadline.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { startCustody } from '../../packages/core-custody/src/agent.ts';
import { parseDestinations, send } from '../../packages/core-custody/src/egress.ts';
import { OLLAMA_DEFAULT_MODEL } from '../../packages/core-connectors/src/index.ts';
import { streamedLines } from './ollama-on-loopback.ts';
import { chatRequest } from './model-agent-world.ts';

/** Far more than loopback's socket buffers hold on either side. */
const LARGE = 16 * 1024 * 1024;
/** How long after the deadline the stand-in starts reading. */
const SLOW_MS = 400;

let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => {
    if (server === undefined) resolve();
    else server.close(() => resolve());
  });
  server = undefined;
});

interface SlowModel {
  readonly origin: string;
  /** When the request's head arrived, and when the whole request had, if they did. */
  readonly whole: { head?: number; at?: number };
}

/** A stand-in model that reads nothing of a request until `from`, then all of it. */
async function slowReader(from: () => number): Promise<SlowModel> {
  const whole: { head?: number; at?: number } = {};
  server = createServer((request, response) => {
    whole.head = Date.now();
    const expected = Number(request.headers['content-length']);
    let size = 0;
    void (async () => {
      await sleep(Math.max(0, from() - Date.now()));
      request.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
      });
      request.on('end', () => {
        if (size === expected) whole.at = Date.now();
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        response.end(streamedLines(OLLAMA_DEFAULT_MODEL, ['Done.']).join(''));
      });
    })();
  });
  const listening = server;
  await new Promise<void>((resolve) => {
    listening.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listening.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${String(port)}`, whole };
}

it('a write still going at the deadline is cut, and the model never holds the whole request', async () => {
  let deadlineAt = Number.POSITIVE_INFINITY;
  const model = await slowReader(() => deadlineAt + SLOW_MS);
  const parsed = parseDestinations([{ key: 'ollama', origin: model.origin }]);
  if (!parsed.ok) throw new Error('the case listed a malformed destination');
  const request = chatRequest({
    messages: [{ role: 'user', content: 'x'.repeat(LARGE) }],
  });
  let writtenAt: number | undefined;
  deadlineAt = Date.now() + 1_000;
  await send(parsed.destinations, request, null, undefined, undefined, {
    deadlineAt,
    onWritten: () => (writtenAt = Date.now()),
  });
  // The write began inside the deadline: the request's head reached the model by then.
  expect(model.whole.head).toBeLessThanOrEqual(deadlineAt);
  // Whatever custody answers, the model must not hold a request it finished receiving after the deadline.
  expect(model.whole.at ?? deadlineAt).toBeLessThanOrEqual(deadlineAt);
  expect(writtenAt ?? deadlineAt).toBeLessThanOrEqual(deadlineAt);
}, 30_000);

it('custody’s own process cuts it too, and never says written after the deadline', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'gated-write-'));
  const credentialsFile = join(folder, 'credentials.json');
  const none = { ref: 'ollama_key', kind: 'api_key', account: 'm5-ollama', destination: 'ollama' };
  writeFileSync(credentialsFile, JSON.stringify([{ ...none, scheme: 'none' }]), { mode: 0o600 });
  let deadlineAt = Number.POSITIVE_INFINITY;
  const model = await slowReader(() => deadlineAt + SLOW_MS);
  const custody = await startCustody({
    credentialsFile,
    destinations: [{ key: 'ollama', origin: model.origin }],
  });
  try {
    let writtenAt: number | undefined;
    const request = chatRequest({ messages: [{ role: 'user', content: 'x'.repeat(LARGE) }] });
    // Set once custody is up and the request made, so the deadline is still ahead when custody connects.
    deadlineAt = Date.now() + 3_000;
    await custody.dispatchBefore('ollama_key', request, {
      deadlineAt,
      onWritten: () => (writtenAt = Date.now()),
    });
    expect(model.whole.head).toBeLessThanOrEqual(deadlineAt);
    expect(model.whole.at ?? deadlineAt).toBeLessThanOrEqual(deadlineAt);
    expect(writtenAt ?? deadlineAt).toBeLessThanOrEqual(deadlineAt);
  } finally {
    await custody.stop();
    rmSync(folder, { recursive: true, force: true });
  }
}, 30_000);

it('control: a request that fits is written and held whole before its deadline', async () => {
  const deadlineAt = Date.now() + 2_000;
  const model = await slowReader(() => 0);
  const parsed = parseDestinations([{ key: 'ollama', origin: model.origin }]);
  if (!parsed.ok) throw new Error('the case listed a malformed destination');
  let writtenAt: number | undefined;
  const outcome = await send(parsed.destinations, chatRequest(), null, undefined, undefined, {
    deadlineAt,
    onWritten: () => (writtenAt = Date.now()),
  });
  expect(outcome.ok).toBe(true);
  expect(model.whole.at).toBeLessThanOrEqual(deadlineAt);
  expect(writtenAt).toBeLessThanOrEqual(deadlineAt);
}, 30_000);
