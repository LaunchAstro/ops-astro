// SPDX-License-Identifier: AGPL-3.0-only
//
// A provider answer under the 16 KiB limit, with a `password` field nested
// deeper than a JSON reviver can walk, is a fault, never `set`: a check that
// cannot read an answer through has not shown it names no password.
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('a reset answer with a password field nested too deep to read is a fault in a fresh Node process', () => {
  const script = `
    import { createServer } from 'node:http';
    import { mkdtempSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { brokerFor } from './tests/api/c40-password-set-broker.ts';
    import { setLoginPassword } from './packages/core-custody/src/broker-login-password.ts';
    const id = 'abcdefab-cdef-4abc-8abc-abcdefabcdef';
    const password = 'Sol valid echoed password';
    const depth = 3_000;
    const body = JSON.stringify({ id }).slice(0, -1) + ',"metadata":' +
      '['.repeat(depth) + JSON.stringify({ password }) + ']'.repeat(depth) + '}';
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => response.writeHead(200, { 'content-type': 'application/json' }).end(body));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const folder = mkdtempSync(join(tmpdir(), 'sol1413-deep-password-'));
    const { broker, custody } = await brokerFor('http://127.0.0.1:' + server.address().port,
      'synthetic-sol-service-key', folder);
    try {
      const result = await setLoginPassword(broker, id, password);
      console.log(JSON.stringify({ result, bytes: Buffer.byteLength(body) }));
    } finally {
      await custody.stop();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      rmSync(folder, { recursive: true, force: true });
    }
  `;
  const ran = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  expect(ran.status, ran.stderr).toBe(0);
  const answer: { result: string; bytes: number } = JSON.parse(ran.stdout);
  expect(answer.bytes).toBeLessThan(16 * 1024);
  expect(answer.result).toBe('fault');
});
