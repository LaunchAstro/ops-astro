// SPDX-License-Identifier: AGPL-3.0-only
//
// The command line and the worker never follow a redirect. Fetch drops the
// bearer on a cross-origin redirect but resends the delegation header, and on
// a 307 the body, so an API or sign-in service, or a proxy in front of one,
// that redirects to another origin would hand the agent's delegation or the
// person's password to that origin. A redirect is an answer the client does
// not act on: the other origin receives nothing and the run does not succeed.

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { main as cli } from '../../apps/cli/main.ts';
import { main as worker } from '../../apps/worker/main.ts';

const BEARER = 'bearer-canary-9a4d17';
const DELEGATION = 'delegation-canary-5c1e08';
const PASSWORD = 'password-canary-31b7e2';
const received: (IncomingHttpHeaders | string)[] = [];
let elsewhere: Server;
let api: Server;
let address = '';

const listening = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as AddressInfo).port;
};

beforeAll(async () => {
  elsewhere = createServer((request, response) => {
    received.push(request.headers);
    request.on('data', (chunk: Buffer) => received.push(chunk.toString()));
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  const other = await listening(elsewhere);
  api = createServer((_request, response) => {
    response.writeHead(307, { location: `http://127.0.0.1:${other}/collect` }).end();
  });
  address = `http://127.0.0.1:${await listening(api)}`;
});

afterAll(() => {
  api.close();
  elsewhere.close();
});

const SETTINGS = {
  OPS_ASTRO_BUSINESS: 'alpha',
  OPS_ASTRO_TOKEN: BEARER,
  OPS_ASTRO_DELEGATION: DELEGATION,
  OPS_ASTRO_AGENT: '1',
};

const printed: string[] = [];
const io = {
  out: (line: string) => printed.push(line),
  err: (line: string) => printed.push(line),
  stdin: async () => await Promise.resolve(''),
};

function expectNothingElsewhere(): void {
  const sent = JSON.stringify(received);
  expect(sent).not.toContain(DELEGATION);
  expect(sent).not.toContain(BEARER);
  expect(sent).not.toContain(PASSWORD);
  expect(received).toEqual([]);
}

describe('a redirect to another origin receives no credential', () => {
  it('the command line sends nothing there and exits as a fault', async () => {
    received.length = 0;
    const code = await cli(
      ['task.create', '--json', '{"fields":{"title":"t"}}'],
      { ...SETTINGS, OPS_ASTRO_API_URL: address },
      io,
    );
    expectNothingElsewhere();
    expect(code).toBe(4);
  });

  it('the worker sends nothing there and exits as a fault', async () => {
    received.length = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await worker(['--once'], { ...SETTINGS, OPS_ASTRO_API_URL: address }, () =>
      Promise.resolve('sent'),
    );
    vi.restoreAllMocks();
    expectNothingElsewhere();
    expect(code).toBe(4);
  });

  it('the command line login sends no password there and is refused', async () => {
    received.length = 0;
    const folder = mkdtempSync(join(tmpdir(), 'redirect-'));
    const code = await cli(
      ['login', '--email', 'person@example.test'],
      {
        OPS_ASTRO_GOTRUE_URL: address,
        OPS_ASTRO_PASSWORD: PASSWORD,
        OPS_ASTRO_TOKEN_FILE: join(folder, 'token'),
      },
      io,
    ).finally(() => {
      rmSync(folder, { recursive: true, force: true });
    });
    expectNothingElsewhere();
    expect(code).toBe(1);
  });
});
