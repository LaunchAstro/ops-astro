// SPDX-License-Identifier: AGPL-3.0-only
//
// The login refuses a redirect from the sign-in service, and says so without
// what the redirect said. A JSON redirect answer can name its destination in
// the message the login would otherwise print, and that destination repeats
// the request path, secret included.

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { main } from '../../apps/cli/main.ts';

it('a refused sign-in redirect keeps the sign-in path secret out of CLI output', async () => {
  const secret = 'sign-in-path-canary-34e1';
  const printed: string[] = [];
  const server = createServer((request, response) => {
    const destination = `/landing${request.url ?? '/'}`;
    response.writeHead(307, { location: destination, 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: `Moved to ${destination}` }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const folder = mkdtempSync(join(tmpdir(), 'login-redirect-'));
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing server port');
    const code = await main(
      ['login', '--email', 'person@example.test'],
      {
        OPS_ASTRO_GOTRUE_URL: `http://127.0.0.1:${address.port}/${secret}`,
        OPS_ASTRO_PASSWORD: 'made-up-password',
        OPS_ASTRO_TOKEN_FILE: join(folder, 'token'),
      },
      {
        out: (line) => printed.push(line),
        err: (line) => printed.push(line),
        stdin: () => Promise.resolve(''),
      },
    );
    expect(code).toBe(1);
    expect(printed.join('\n')).not.toContain(secret);
  } finally {
    rmSync(folder, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }
});
