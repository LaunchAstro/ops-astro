// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { main } from '../../apps/cli/main.ts';

it('a missing preset value refuses before sending a write', async () => {
  const seen: { path: string; body: string; bearer: string | undefined }[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      seen.push({ path: request.url ?? '', body, bearer: request.headers.authorization });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ recordId: 'created-task', revision: 1 }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no loopback port');
    const printed: string[] = [];
    const code = await main(
      ['task', 'create', '--title', 'Synthetic task', '--env'],
      {
        OPS_ASTRO_API_URL: `http://127.0.0.1:${String(address.port)}`,
        OPS_ASTRO_BUSINESS: 'alpha',
        OPS_ASTRO_TOKEN: 'synthetic-bearer',
      },
      {
        out: (line) => printed.push(line),
        err: (line) => printed.push(line),
        stdin: async () => '',
      },
    );
    expect(code, JSON.stringify({ seen, printed })).toBe(2);
    expect(seen).toStrictEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});
