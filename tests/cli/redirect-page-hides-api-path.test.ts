// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { main } from '../../apps/cli/main.ts';

it('a refused redirect keeps the configured API path secret out of CLI output', async () => {
  const secret = 'sol-path-canary-811';
  const printed: string[] = [];
  // A redirect page includes its destination, as ordinary HTTP redirect pages do.
  // Its destination preserves the request path, including the configured secret.
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/landing/')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    const destination = `/landing${request.url ?? '/'}`;
    response.writeHead(307, { location: destination, 'content-type': 'text/html' });
    response.end(
      `<p>Temporary Redirect. Redirecting to <a href="${destination}">${destination}</a></p>`,
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing server port');
    const code = await main(
      ['task.create', '--json', '{"fields":{"title":"t"}}'],
      {
        OPS_ASTRO_BUSINESS: 'alpha',
        OPS_ASTRO_TOKEN: 'sol-made-up-bearer',
        OPS_ASTRO_API_URL: `http://127.0.0.1:${address.port}/${secret}`,
      },
      {
        out: (line) => printed.push(line),
        err: (line) => printed.push(line),
        stdin: () => Promise.resolve(''),
      },
    );
    expect(code).toBe(4);
    expect(printed.join('\n')).not.toContain(secret);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }
});
