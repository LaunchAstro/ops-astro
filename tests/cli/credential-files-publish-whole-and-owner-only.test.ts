// SPDX-License-Identifier: AGPL-3.0-only
//
// A saved credential is a new owner-only file renamed into place: the new
// bearer never goes into an existing file that others could read, and a
// reader in another process sees one whole token or the one before it, never
// a part or a blank. While another command holds the credentials' lock, a
// login waits, then stops and names it, having sent nothing.

import { spawn } from 'node:child_process';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, standIn } from './preset-stand-in.ts';

const ISSUER = 'https://issuer.example.test/auth/v1';
const LONG = 'x'.repeat(256 * 1024);

let folder: string;
let tokenFile: string;
let granted = 0;
let sent = 0;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cli-publish-'));
  tokenFile = join(folder, 'token');
  granted = 0;
  sent = 0;
  vi.stubGlobal(
    'fetch',
    standIn(() => {
      sent += 1;
      granted += 1;
      return Response.json({ access_token: `${String(granted)}-${LONG}` });
    }).fetch,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(folder, { recursive: true, force: true });
});

const env = (): Record<string, string> => ({
  OPS_ASTRO_GOTRUE_URL: ISSUER,
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test-only',
  OPS_ASTRO_PASSWORD: 'publish-password',
  OPS_ASTRO_TOKEN_FILE: tokenFile,
});

// eslint-disable-next-line max-lines-per-function -- three cases over one set of files
describe('credential files are published whole and owner-only', () => {
  it('a readable old file never receives the new bearer', async () => {
    writeFileSync(tokenFile, 'old-bearer\n', { mode: 0o644 });
    const held = openSync(tokenFile, 'r');
    try {
      const { code, err } = await run(['login', '--email', 'a@example.test'], env());
      expect(code, err).toBe(0);
      const now = statSync(tokenFile);
      expect(now.mode & 0o777).toBe(0o600);
      expect(now.ino).not.toBe(fstatSync(held).ino);
      const buffer = Buffer.alloc(64);
      const read = readSync(held, buffer, 0, 64, 0);
      expect(buffer.subarray(0, read).toString('utf8')).toBe('old-bearer\n');
      expect(readFileSync(tokenFile, 'utf8')).toBe(`1-${LONG}\n`);
    } finally {
      closeSync(held);
    }
  });

  it('a reader in another process never sees a part or a blank', async () => {
    expect((await run(['login', '--email', 'a@example.test'], env())).code).toBe(0);
    const stop = join(folder, 'stop');
    const reader = spawn(
      process.execPath,
      [
        '-e',
        `const fs = require('node:fs');
         const [file, stop, size] = process.argv.slice(1);
         let reads = 0, bad = 0;
         while (!fs.existsSync(stop)) {
           let text = '';
           try { text = fs.readFileSync(file, 'utf8'); } catch {}
           reads += 1;
           if (!/^\\d+-x+\\n$/.test(text) || text.length < Number(size)) bad += 1;
         }
         process.stdout.write(JSON.stringify({ reads, bad }));`,
        tokenFile,
        stop,
        String(LONG.length + 3),
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let said = '';
    reader.stdout.on('data', (chunk: Buffer) => (said += chunk.toString('utf8')));
    const ended = new Promise<void>((resolve) => {
      reader.once('close', () => resolve());
    });
    for (let at = 0; at < 200; at += 1) {
      // eslint-disable-next-line no-await-in-loop -- one login after another
      const { code } = await run(['login', '--email', 'a@example.test'], env());
      expect(code).toBe(0);
    }
    writeFileSync(stop, '');
    await ended;
    const { reads, bad } = JSON.parse(said) as { reads: number; bad: number };
    expect(reads).toBeGreaterThan(0);
    expect(bad).toBe(0);
  }, 60_000);

  it('a login waits for the lock, then stops, names it and sends nothing', async () => {
    mkdirSync(`${tokenFile}.lock`);
    const started = Date.now();
    const { code, err } = await run(['login', '--email', 'a@example.test'], env());
    expect(code).toBe(2);
    expect(err).toContain(`${tokenFile}.lock`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_500);
    expect(sent).toBe(0);
  }, 15_000);
});
