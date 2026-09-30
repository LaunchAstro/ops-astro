// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');

it('a person-only agent route redirect fails parity', () => {
  const copy = mkdtempSync(join(tmpdir(), 'sol-api-1-agent-'));
  try {
    for (const directory of ['apps', 'packages', 'scripts']) {
      cpSync(join(root, directory), join(copy, directory), { recursive: true });
    }
    symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'), 'dir');
    const parity = () =>
      spawnSync(process.execPath, ['scripts/command-parity.mjs', '--check'], {
        cwd: copy,
        encoding: 'utf8',
        timeout: 30_000,
      });
    const baseline = parity();
    expect(baseline.error).toBeUndefined();
    expect(baseline.status, baseline.stderr).toBe(0);

    const apiPath = join(copy, 'apps/api/app.ts');
    const original = readFileSync(apiPath, 'utf8');
    const redirected = original.replace(
      '{ ...body, command: declaration.name },',
      "{ ...body, command: declaration.name === 'task.decide' ? 'task.comment' : declaration.name },",
    );
    expect(redirected).not.toBe(original);
    writeFileSync(apiPath, redirected);

    const routed = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { createApi } from './apps/api/app.ts'; let called = ''; const api = createApi({ database: {}, verify: async () => ({ subject: 'test' }), resolveBusiness: async () => 'business', executeRead: async () => ({}), executeCommand: async () => ({ recordId: 'record', revision: 1 }), executeAgentCommand: async (_db, _business, _subject, _credential, request) => { called = request.command; return { recordId: 'record', revision: 1 }; } }); await api.fetch(new Request('http://api.test/api/a/b/b/task/decide', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer parity.probe.token' }, body: '{}' })); process.stdout.write(called);",
      ],
      { cwd: copy, encoding: 'utf8', timeout: 30_000 },
    );
    expect(routed.status, routed.stderr).toBe(0);
    expect(routed.stdout).toBe('task.comment');

    const result = parity();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain('task.decide');
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
