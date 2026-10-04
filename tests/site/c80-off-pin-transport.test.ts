// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 dns rebinding, a socket that lands off the pin: the production
// transport against a loopback TLS server at an address other than the one it
// was pinned to. A URL whose host is an address literal is connected to
// directly, with no lookup, so the pinned lookup cannot steer it: the socket
// really lands on 127.0.0.1 while the pin says ::1. The transport must see the
// difference at connect and read nothing, although the server there would
// answer (its certificate holds that address). The platform refuses some
// requests before any socket (an address as the TLS server name, a header
// value with a line break); those are an answer too, never a rejection whose
// text could carry the host.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  pinnedTransport,
  type TransportRequest,
} from '../../packages/core-connectors/src/index.ts';

const LANDED = '127.0.0.1';
const PINNED = '::1';
let dir = '';
let server: Server | undefined;
let port = 0;
let ca = '';
let connections = 0;
let requests = 0;

function makeCertificate(into: string): void {
  const subject = ['-subj', `/CN=${LANDED}`, '-addext', `subjectAltName=IP:${LANDED}`];
  const curve = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1'];
  const files = ['-keyout', join(into, 'key.pem'), '-out', join(into, 'cert.pem')];
  execFileSync(
    'openssl',
    ['req', '-x509', ...curve, '-nodes', '-days', '1', ...subject, ...files],
    { stdio: 'ignore' },
  );
}

async function start(): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'c80-off-pin-'));
  makeCertificate(dir);
  ca = readFileSync(join(dir, 'cert.pem'), 'utf8');
  const started = createServer(
    { key: readFileSync(join(dir, 'key.pem')), cert: ca },
    (_incoming, response) => {
      requests += 1;
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<p>the other host</p>');
    },
  );
  started.on('connection', () => {
    connections += 1;
  });
  server = started;
  await new Promise<void>((done) => {
    started.listen(0, LANDED, done);
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

function request(): TransportRequest {
  return {
    url: new URL(`https://${LANDED}:${port}/`),
    address: PINNED,
    family: 6,
    headers: { accept: 'text/html', 'user-agent': 'fence-test' },
    timeoutMs: 2_000,
    maxBytes: 1_024,
  };
}

describe('C80 dns rebinding: a socket that lands off the pin', () => {
  beforeAll(start);
  afterAll(stop);

  it('is refused at connect, and nothing is asked of or read from the host it reached', async () => {
    const got = await pinnedTransport({ ca })(request());
    expect(got).toEqual({ kind: 'address_changed' });
    // The socket did reach the other host: the refusal is the transport's,
    // not a connection that never happened.
    expect(connections).toBe(1);
    expect(requests).toBe(0);
  });

  it('answers failed, never a rejection carrying its text, for a request the platform will not send', async () => {
    const before = connections;
    const got = await pinnedTransport({ ca })({
      ...request(),
      headers: { 'user-agent': 'fence-test', 'x-planted': `canary\r\nhost: ${LANDED}` },
    });
    expect(got).toEqual({ kind: 'failed' });
    expect(connections).toBe(before);
  });
});
