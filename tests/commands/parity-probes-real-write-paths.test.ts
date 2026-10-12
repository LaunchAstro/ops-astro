// SPDX-License-Identifier: AGPL-3.0-only
//
// Command parity runs what each route really runs. A copy of the sources has
// one change planted at a time, and `command-parity.mjs --check` must fail on
// it: the write grant check removed from the command preparation, a route
// that runs a sibling command before its own, and a redirect on the agent
// prefix's credential path.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
let copy = '';

const parity = () =>
  spawnSync(process.execPath, ['scripts/command-parity.mjs', '--check'], {
    cwd: copy,
    encoding: 'utf8',
    timeout: 60_000,
  });

/** Parity on the copy with `from` replaced by `to` in `file`, the file put back after. */
function plantedParity(file: string, from: string, to: string) {
  const path = join(copy, file);
  const original = readFileSync(path, 'utf8');
  const planted = original.replace(from, to);
  expect(planted, `the planted change applies to ${file}`).not.toBe(original);
  writeFileSync(path, planted);
  try {
    return parity();
  } finally {
    writeFileSync(path, original);
  }
}

describe('command parity probes the real write paths', () => {
  beforeAll(() => {
    copy = mkdtempSync(join(tmpdir(), 'parity-write-paths-'));
    for (const directory of ['apps', 'packages', 'scripts']) {
      cpSync(join(root, directory), join(copy, directory), { recursive: true });
    }
    symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'), 'dir');
    const baseline = parity();
    expect(baseline.status, baseline.stdout + baseline.stderr).toBe(0);
  }, 120_000);
  afterAll(() => rmSync(copy, { recursive: true, force: true }));
  plantedCases();
});

function plantedCases(): void {
  it('fails when the write grant check admits everything', () => {
    const result = plantedParity(
      'packages/core-commands/src/commands/prepare.ts',
      'const authorised = await checkAuthority(tx, subjectsOf(session), asked);',
      'const authorised = { ok: true as const };',
    );
    expect(result.status, 'parity passed with write enforcement removed').toBe(1);
    expect(result.stdout).toContain('task.update');
  }, 120_000);

  it('fails when a route runs a sibling command before its own', () => {
    const result = plantedParity(
      'apps/api/app.ts',
      "const result = await options.executeCommand(options.database, businessId, presented, 'api', {",
      `if (name === 'task.update') {
        await options.executeCommand(options.database, businessId, presented, 'api', {
          ...body,
          command: 'task.comment',
        });
      }
      const result = await options.executeCommand(options.database, businessId, presented, 'api', {`,
    );
    expect(result.status, 'parity passed a route that also ran another command').toBe(1);
    expect(result.stdout).toContain('task.update');
  }, 120_000);

  it("fails when the agent prefix's credential path runs another command", () => {
    const result = plantedParity(
      'apps/api/app.ts',
      `const answer = await run(options.database, businessId, call, {
          ...body,
          command: declaration.name,
        });`,
      `const answer = await run(options.database, businessId, call, {
          ...body,
          command: declaration.name === 'task.read' ? 'task.board' : declaration.name,
        });`,
    );
    expect(result.status, 'parity passed a redirect on the credential path').toBe(1);
    expect(result.stdout).toContain('task.read');
  }, 120_000);
}
