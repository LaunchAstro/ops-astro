// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('Sol proof, criterion 10: a scanner that cannot start raises the failed-scan alert', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'sol-s0-2-scan-'));
  const bin = mkdtempSync(join(tmpdir(), 'sol-s0-2-bin-'));
  const received: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (part: Buffer) => (body += part.toString()));
    request.on('end', () => {
      received.push(JSON.parse(body) as Record<string, unknown>);
      response.end('{}');
    });
  });
  try {
    copyFileSync('.gitleaks.toml', join(repo, '.gitleaks.toml'));
    writeFileSync(join(repo, 'safe.txt'), 'safe content\n');
    const unavailable = join(bin, 'gitleaks');
    writeFileSync(unavailable, '#!/bin/sh\nexit 1\n');
    chmodSync(unavailable, 0o755);
    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', () => done());
    });
    const port = (server.address() as AddressInfo).port;
    const run = (command: string, args: string[], env = process.env) =>
      new Promise<{ code: number; output: string }>((done) => {
        execFile(command, args, { cwd: repo, env, timeout: 30_000 }, (error, stdout, stderr) => {
          done({ code: error === null ? 0 : Number(error.code ?? 1), output: stdout + stderr });
        });
      });
    expect((await run('git', ['init', '-q'])).code).toBe(0);
    const scan = await run(process.execPath, [resolve('scripts/secrets-scan.mjs')], {
      ...process.env,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      OPS_ERROR_SINK_DSN: `http://fakekey@127.0.0.1:${port}/9`,
      OPS_ENVIRONMENT: 'staging',
    });
    expect(scan.code).toBe(1);
    expect(scan.output).toContain('gitleaks is not installed or not on PATH');
    expect(received.map((event) => (event['tags'] as Record<string, string>)['alert'])).toEqual([
      'secret-scan-failed',
    ]);
  } finally {
    await new Promise<void>((done) => {
      server.close(() => done());
    });
    rmSync(repo, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
