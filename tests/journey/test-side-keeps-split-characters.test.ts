// SPDX-License-Identifier: AGPL-3.0-only
//
// A test-side run's output reaches its case lines and its stderr evidence
// with every character intact, even when a multibyte character arrives split
// across two writes of the child process.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runTestSide } from '../../scripts/local/journey-process.ts';

const dir = mkdtempSync(join(tmpdir(), 'test-side-split-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('a test-side run', () => {
  it('keeps a character split across two writes, on stdout and stderr', async () => {
    const child = join(dir, 'child.mjs');
    // `é` is two bytes; each stream gets its first byte, a pause, then the rest.
    writeFileSync(
      child,
      `const bytes = Buffer.from('café\\n');
const pause = () => new Promise((done) => setTimeout(done, 100));
for (const stream of [process.stdout, process.stderr]) {
  stream.write(bytes.subarray(0, 4));
  await pause();
  stream.write(bytes.subarray(4));
}
`,
    );
    const taken: string[] = [];
    const stderr = join(dir, 'stderr.txt');
    const code = await runTestSide({
      root: dir,
      file: child,
      env: {},
      pidfile: join(dir, 'pids'),
      stderr,
      password: 'unused-password',
      take: (line) => taken.push(line),
    });
    expect(code).toBe(0);
    expect({ taken, stderr: readFileSync(stderr, 'utf8') }).toStrictEqual({
      taken: ['café'],
      stderr: 'café\n',
    });
  });
});
