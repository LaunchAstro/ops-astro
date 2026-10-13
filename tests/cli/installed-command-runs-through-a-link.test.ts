// SPDX-License-Identifier: AGPL-3.0-only
//
// The installed command: `ops-astro`, a link on PATH to `apps/cli/main.ts` in a
// checkout (docs/local/CLI.md, "Installing"). The link is run as a program in
// its own right, from a folder outside the checkout, so the entry's shebang,
// its executable bit and its real-path check are what make it answer. The help
// names the installed command.

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ENTRY = join(import.meta.dirname, '..', '..', 'apps', 'cli', 'main.ts');

let folder: string;
let link: string;

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'cli-installed-'));
  link = join(folder, 'ops-astro');
  symlinkSync(ENTRY, link);
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

async function run(args: readonly string[]) {
  return await new Promise<{ code: number; out: string; err: string }>((resolve) => {
    execFile(
      link,
      args,
      {
        cwd: folder,
        // The shebang finds node on PATH; this test's own node comes first.
        env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: folder },
      },
      (error, out, err) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
        resolve({ code, out, err });
      },
    );
  });
}

describe('the installed command runs through a link on PATH', () => {
  it('ops-astro --help lists the operations under the installed name', async () => {
    const { code, out } = await run(['--help']);
    expect(code).toBe(0);
    expect(out).toContain('usage: ops-astro <operation>');
    expect(out).toContain('  task.read\n');
  });

  it('ops-astro help lists the verbs under the installed name', async () => {
    const { code, out } = await run(['help']);
    expect(code).toBe(0);
    expect(out).toContain('ops-astro <verb> [args]');
    expect(out).toContain('  task list ');
  });

  it('a verb with no business or sign-in stops before sending anything', async () => {
    const { code, err } = await run(['task', 'list']);
    expect(code).toBe(2);
    expect(err).toContain('name the business');
  });
});
