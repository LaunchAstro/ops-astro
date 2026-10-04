// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 dns rebinding, the production transport: a loopback TLS server with a
// certificate made for this test, reached for a name DNS cannot resolve, so
// the only way the request arrives is through the pinned address.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  pinnedTransport,
  type TransportRequest,
} from '../../packages/core-connectors/src/index.ts';

const NAME = 'pilot.invalid';
const hosts: string[] = [];
let dir = '';
let server: Server | undefined;
let port = 0;
let ca = '';

function makeCertificate(into: string): void {
  const subject = ['-subj', `/CN=${NAME}`, '-addext', `subjectAltName=DNS:${NAME}`];
  const curve = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1'];
  const files = ['-keyout', join(into, 'key.pem'), '-out', join(into, 'cert.pem')];
  execFileSync(
    'openssl',
    ['req', '-x509', ...curve, '-nodes', '-days', '1', ...subject, ...files],
    {
      stdio: 'ignore',
    },
  );
}

function answer(incoming: IncomingMessage, response: ServerResponse): void {
  hosts.push(incoming.headers.host ?? '');
  if (incoming.url === '/slow') return;
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(incoming.url === '/big' ? 'x'.repeat(4096) : '<p>pinned</p>');
}

async function start(): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'c80-tls-'));
  makeCertificate(dir);
  ca = readFileSync(join(dir, 'cert.pem'), 'utf8');
  const started = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: ca }, answer);
  server = started;
  await new Promise<void>((done) => {
    started.listen(0, '127.0.0.1', done);
  });
  port = (started.address() as AddressInfo).port;
}

async function stop(): Promise<void> {
  const running = server;
  if (running !== undefined) {
    running.closeAllConnections();
    await new Promise<void>((done) => {
      running.close(() => done());
    });
  }
  rmSync(dir, { recursive: true, force: true });
}

function request(path: string, overrides: Partial<TransportRequest> = {}): TransportRequest {
  return {
    url: new URL(`https://${NAME}:${port}${path}`),
    address: '127.0.0.1',
    family: 4,
    headers: { accept: 'text/html', 'user-agent': 'fence-test' },
    timeoutMs: 2_000,
    maxBytes: 1_024,
    ...overrides,
  };
}

describe('C80 dns rebinding: the production transport', () => {
  beforeAll(start);
  afterAll(stop);

  it('reaches the pinned address for a name DNS cannot resolve, with SNI and host kept', async () => {
    const got = await pinnedTransport({ ca })(request('/'));
    expect(got).toMatchObject({ kind: 'answer', status: 200 });
    if (got.kind !== 'answer') return;
    expect(new TextDecoder().decode(got.body)).toBe('<p>pinned</p>');
    expect(hosts.at(-1)).toBe(`${NAME}:${port}`);
  });

  it('stops at the byte cap and at the timeout', async () => {
    expect(await pinnedTransport({ ca })(request('/big'))).toEqual({ kind: 'oversized' });
    expect(await pinnedTransport({ ca })(request('/slow', { timeoutMs: 200 }))).toEqual({
      kind: 'timeout',
    });
  });

  it('refuses a certificate the trust roots do not hold', async () => {
    expect(await pinnedTransport()(request('/'))).toEqual({ kind: 'failed' });
  });
});
