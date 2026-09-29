// SPDX-License-Identifier: AGPL-3.0-only
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const originalPath = process.env['PATH'];
const originalSslmode = process.env['PGSSLMODE'];
const originalCapture = process.env['SOL_CAPTURE_PATH'];

afterEach(() => {
  if (originalPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = originalPath;
  if (originalSslmode === undefined) delete process.env['PGSSLMODE'];
  else process.env['PGSSLMODE'] = originalSslmode;
  if (originalCapture === undefined) delete process.env['SOL_CAPTURE_PATH'];
  else process.env['SOL_CAPTURE_PATH'] = originalCapture;
});

it('the source dump requires encrypted transport', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sol-s0-3c-'));
  try {
    const capture = join(directory, 'docker.json');
    const docker = join(directory, 'docker');
    writeFileSync(
      docker,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.SOL_CAPTURE_PATH, JSON.stringify({ args: process.argv.slice(2), sslmode: process.env.PGSSLMODE }));
process.stdout.write('PGDMP fixture');
`,
    );
    chmodSync(docker, 0o755);
    process.env['PATH'] = `${directory}${delimiter}${originalPath ?? ''}`;
    process.env['PGSSLMODE'] = 'disable';
    process.env['SOL_CAPTURE_PATH'] = capture;
    const path = '../../scripts/ops/backup.mjs';
    const { pgDump }: { pgDump: (url: string) => Promise<Buffer> } = await import(
      /* @vite-ignore */ path
    );
    await pgDump('postgres://backup:dummy@example.invalid/operations');
    const command = JSON.parse(readFileSync(capture, 'utf8')) as {
      args: string[];
      sslmode: string | undefined;
    };
    const requiresTls =
      /^(require|verify-ca|verify-full)$/u.test(command.sslmode ?? '') ||
      command.args.some((arg) => /sslmode=(require|verify-ca|verify-full)/u.test(arg));
    expect(requiresTls).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
