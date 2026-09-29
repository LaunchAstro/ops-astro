// SPDX-License-Identifier: AGPL-3.0-only
// S0-2 security: a failed secret scan raises the owner's alert from the real
// scanner, `scripts/secrets-scan.mjs`, run as the deploy runs it.
//
// A throwaway repository carries the repository's gitleaks settings and, in
// the failing case, a made-up key in the gitleaks generic shape, generated
// here so no key is ever committed. The sink is a fake on a loopback port.
// Without a sink the scan fails the same way and sends nothing.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCANNER = resolve('scripts/secrets-scan.mjs');
const received: Record<string, unknown>[] = [];
let dsn = '';
const server = createServer((request: IncomingMessage, response) => {
  let body = '';
  request.on('data', (chunk: Buffer) => (body += chunk.toString()));
  request.on('end', () => {
    received.push(JSON.parse(body) as Record<string, unknown>);
    response.end('{}');
  });
});

beforeAll(async () => {
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  dsn = `http://fakekey@127.0.0.1:${(server.address() as AddressInfo).port}/9`;
});
afterAll(async () => {
  await new Promise((done) => {
    server.close(done);
  });
});

function repository(withKey: boolean): { dir: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), 's0-2-scan-'));
  copyFileSync('.gitleaks.toml', join(dir, '.gitleaks.toml'));
  const key = randomBytes(24).toString('hex');
  writeFileSync(join(dir, 'service.env'), withKey ? `SERVICE_TOKEN="${key}"\n` : 'NOTHING=here\n');
  return { dir, key };
}

async function scan(dir: string, env: Record<string, string>) {
  const run = (command: string, args: string[]) =>
    new Promise<{ code: number; out: string }>((done) => {
      execFile(
        command,
        args,
        { cwd: dir, env: { PATH: process.env['PATH'] ?? '', ...env }, timeout: 60_000 },
        (error, stdout, stderr) => {
          done({ code: error === null ? 0 : Number(error.code ?? 1), out: stdout + stderr });
        },
      );
    });
  await run('git', ['init', '-q']);
  return await run(process.execPath, [SCANNER]);
}

describe('S0-2 security: a failed secret scan raises the alert from the scanner itself', () => {
  it('a key found raises one secret-scan alert in plain words, naming no file or key', async () => {
    const { dir, key } = repository(true);
    try {
      received.length = 0;
      const result = await scan(dir, { OPS_ERROR_SINK_DSN: dsn, OPS_ENVIRONMENT: 'staging' });
      expect(result.code).toBe(1);
      expect(received.map((event) => (event['tags'] as Record<string, string>)['alert'])).toEqual([
        'secret-scan-failed',
      ]);
      const sent = JSON.stringify(received);
      expect(sent.includes(key), 'the key').toBe(false);
      expect(sent.includes('service.env'), 'the file').toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('a clean scan raises nothing, and a failed one without a sink still fails and sends nothing', async () => {
    const clean = repository(false);
    const leaking = repository(true);
    try {
      received.length = 0;
      const env = { OPS_ERROR_SINK_DSN: dsn, OPS_ENVIRONMENT: 'staging' };
      expect((await scan(clean.dir, env)).code).toBe(0);
      expect((await scan(leaking.dir, {})).code).toBe(1);
      expect(received).toEqual([]);
    } finally {
      rmSync(clean.dir, { recursive: true, force: true });
      rmSync(leaking.dir, { recursive: true, force: true });
    }
  }, 90_000);
});
