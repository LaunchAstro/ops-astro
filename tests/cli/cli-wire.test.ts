// SPDX-License-Identifier: AGPL-3.0-only
//
// What the command line puts on the wire: the prefix, the delegation header,
// and the answer it gives on its own for a verb it does not know (thermo M11).
//
// The real `apps/cli/main.ts` runs as its own process against an HTTP stand-in
// that records the path and the headers of every request. The header name is
// compared with `DELEGATION_HEADER` from `packages/core-records/src/commands/
// surface.ts`, the constant the API reads the header by, so the two sides
// cannot drift apart without this file failing.

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DELEGATION_HEADER } from '../../packages/core-records/src/commands/surface.ts';
import { runCli } from './cli-process-harness.ts';

interface Seen {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly delegation: string | undefined;
}

// eslint-disable-next-line max-lines-per-function -- one stand-in, the calls that share it
describe('the command line sends to the mounted prefixes with the API header name', () => {
  const seen: Seen[] = [];
  let server: Server;
  let origin = '';

  beforeAll(async () => {
    server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        const delegation = request.headers[DELEGATION_HEADER];
        seen.push({
          path: request.url ?? '',
          authorization: request.headers.authorization,
          delegation: typeof delegation === 'string' ? delegation : undefined,
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    origin = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    OPS_ASTRO_API_URL: origin,
    OPS_ASTRO_BUSINESS: 'alpha',
    OPS_ASTRO_TOKEN: 'stand-in-bearer',
    OPS_ASTRO_TOKEN_FILE: '/nonexistent/token',
    OPS_ASTRO_DELEGATION_FILE: '/nonexistent/delegation',
    ...extra,
  });

  it('a person call goes to /api/b/<business> with the bearer and no delegation', async () => {
    const run = await runCli(['person.list'], env({ OPS_ASTRO_DELEGATION: 'held' }));
    expect(run.code).toBe(0);
    expect(seen.at(-1)).toEqual({
      path: '/api/b/alpha/person/list',
      authorization: 'Bearer stand-in-bearer',
      delegation: undefined,
    });
  });

  it('an agent call goes to /api/a/b/<business> with the delegation in the API header', async () => {
    const run = await runCli(['task.queue', '--agent'], env({ OPS_ASTRO_DELEGATION: 'held' }));
    expect(run.code).toBe(0);
    expect(seen.at(-1)).toEqual({
      path: '/api/a/b/alpha/task/queue',
      authorization: 'Bearer stand-in-bearer',
      delegation: 'held',
    });
  });

  it('an agent call with no delegation sends no header', async () => {
    const run = await runCli(['task.queue', '--agent'], env());
    expect(run.code).toBe(0);
    expect(seen.at(-1)).toEqual({
      path: '/api/a/b/alpha/task/queue',
      authorization: 'Bearer stand-in-bearer',
      delegation: undefined,
    });
  });

  it('a business key is encoded into the prefix', async () => {
    const run = await runCli(['person.list', '--business', 'a b'], env());
    expect(run.code).toBe(0);
    expect(seen.at(-1)?.path).toBe('/api/b/a%20b/person/list');
  });

  it('an unknown verb prints the COMMAND_UNKNOWN body, exits 2 and sends nothing', async () => {
    const before = seen.length;
    const run = await runCli(['task.teleport'], env());
    expect(run.code).toBe(2);
    expect(run.stdout).toBe(
      `${JSON.stringify({
        code: 'COMMAND_UNKNOWN',
        names: ['task.teleport'],
        fixes: ['Run with no arguments to list the operations this command line offers.'],
      })}\n`,
    );
    expect(run.stderr).toBe('');
    expect(seen.length).toBe(before);
  });
});
