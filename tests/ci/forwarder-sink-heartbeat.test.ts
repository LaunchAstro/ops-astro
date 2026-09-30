// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-2 heartbeats, the error sink's (gap 6): the sink runs on the machine, so
// the forwarder asks its health page after each pass and pings the sink's
// heartbeat only on a yes, whatever the pass did. The real process, its sink
// and heartbeat served by a loopback stand-in for `example.test`.

import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const asked: string[] = [];
let health = 200;
const server = createServer((request, response) => {
  asked.push(request.url ?? '');
  response.statusCode = request.url === '/_health/' ? health : 200;
  response.end('');
});
let port = '';

beforeAll(async () => {
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  port = String((server.address() as AddressInfo).port);
});
afterAll(async () => {
  await new Promise((done) => {
    server.close(done);
  });
});

async function once(): Promise<void> {
  await promisify(execFile)(process.execPath, ['scripts/ops/forwarder.mjs', '--once'], {
    env: {
      PATH: process.env['PATH'] ?? '',
      NODE_OPTIONS: `--import=${resolve('tests/support/sink-at-loopback.mjs')}`,
      TEST_SINK_PORT: port,
      // No database answers here: the pass fails, and the sink is judged alone.
      DATABASE_FORWARDER_URL: 'postgres://nobody:nothing@127.0.0.1:1/none',
      OPS_ERROR_SINK_DSN: 'https://sinkkey@example.test/7',
      OPS_ENVIRONMENT: 'staging',
      OPS_SINK_HEARTBEAT_URL: 'https://example.test/sink-beat',
    },
    timeout: 30_000,
  }).catch(() => null);
}

describe('S0-2 heartbeats: the error sink', () => {
  it('pings the sink heartbeat after a pass while the sink health page answers', async () => {
    asked.length = 0;
    health = 200;
    await once();
    expect(asked).toEqual(['/_health/', '/sink-beat']);
  });

  it('pings nothing for the sink while its health page does not answer', async () => {
    asked.length = 0;
    health = 503;
    await once();
    expect(asked).toEqual(['/_health/']);
  });
});
