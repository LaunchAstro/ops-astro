// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');

// access.grant and access.revoke share one profile (access:manage, business,
// person-only, no rule), so a route that runs the other one compares equal.
it('an API command redirected to a sibling with the same grants fails parity', () => {
  const copy = mkdtempSync(join(tmpdir(), 'p15-same-profile-'));
  try {
    for (const directory of ['apps', 'packages', 'scripts']) {
      cpSync(join(root, directory), join(copy, directory), { recursive: true });
    }
    symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'), 'dir');
    const parity = () =>
      spawnSync(process.execPath, ['scripts/command-parity.mjs', '--check'], {
        cwd: copy,
        encoding: 'utf8',
        timeout: 60_000,
      });
    const baseline = parity();
    expect(baseline.error).toBeUndefined();
    expect(baseline.status, baseline.stderr).toBe(0);

    const apiPath = join(copy, 'apps/api/app.ts');
    const original = readFileSync(apiPath, 'utf8');
    const redirected = original.replace(
      'command: name,',
      "command: name === 'access.grant' ? 'access.revoke' : name,",
    );
    expect(redirected).not.toBe(original);
    writeFileSync(apiPath, redirected);

    // The planted route really runs the other command.
    const routed = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { createApi } from './apps/api/app.ts'; let called = ''; const api = createApi({ database: {}, verify: async () => ({ subject: 'test' }), resolveBusiness: async () => 'business', executeRead: async () => ({}), executeCommand: async (_db, _business, _subject, _entry, request) => { called = request.command; return { recordId: 'record', revision: 1 }; } }); await api.fetch(new Request('http://api.test/api/b/b/access/grant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })); process.stdout.write(called);",
      ],
      { cwd: copy, encoding: 'utf8', timeout: 30_000 },
    );
    expect(routed.status, routed.stderr).toBe(0);
    expect(routed.stdout).toBe('access.revoke');

    const result = parity();
    expect(result.error).toBeUndefined();
    expect(
      result.status,
      'command parity passes an API path that runs a different command with the same grants ' +
        '(POST .../access/grant runs access.revoke)',
    ).toBe(1);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}, 180_000);
