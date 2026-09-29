// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildCatalogue, reachableBy } from '../../packages/core-wire/src/index.ts';
// @ts-expect-error -- the parity runner is a plain JavaScript module
import { run } from '../../scripts/command-parity.mjs';

const root = join(import.meta.dirname, '../..');

it('Sol proof, criterion 3: slashes in a string do not hide a stateful action', () => {
  const files = new Map([
    [
      'screen-registry.tsx',
      "import { Detail } from './screens/Detail.tsx';\n  'agency:task-detail': () => <Detail />",
    ],
    [
      'screens/Detail.tsx',
      'const onClick = () => { const help = "Use // to search"; client.mutate("task.nudge", {}); };',
    ],
  ]);
  expect(run(files).failures).toContain(
    'the app action task.nudge at agency:task-detail (screens/Detail.tsx) has no CLI verb',
  );
});

it('Sol proof, criterion 4: an API command redirected past its grant fails parity', () => {
  const copy = mkdtempSync(join(tmpdir(), 'sol-api-1-api-'));
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
      'const request = { ...body, command: declaration.name } as CommandRequest;',
      "const request = { ...body, command: declaration.name === 'task.assign' ? 'task.update' : declaration.name } as CommandRequest;",
    );
    expect(redirected).not.toBe(original);
    writeFileSync(apiPath, redirected);

    const routed = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { createApi } from './apps/api/app.ts'; let called = ''; const api = createApi({ database: {}, verify: async () => ({ subject: 'test' }), resolveBusiness: async () => 'business', executeRead: async () => ({}), executeCommand: async (_db, _business, _subject, _entry, request) => { called = request.command; return { recordId: 'record', revision: 1 }; } }); await api.fetch(new Request('http://api.test/api/b/b/task/assign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })); process.stdout.write(called);",
      ],
      { cwd: copy, encoding: 'utf8', timeout: 30_000 },
    );
    expect(routed.status, routed.stderr).toBe(0);
    expect(routed.stdout).toBe('task.update');

    const result = parity();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain('task.assign');
    expect(result.stdout).toContain('task:assign');
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

it('Sol proof, criterion 9: an agent before pickup can discover queue and pickup', () => {
  const commands = reachableBy(buildCatalogue([]), { kind: 'agent', grants: [] }).map(
    (one) => one.command,
  );
  expect(commands).toContain('task.queue');
  expect(commands).toContain('task.pickup');
});

it('Sol proof, criterion 9: an agent command has no person app entry point', () => {
  const rows = buildCatalogue([
    { command: 'task.comment', route: 'agency:task-detail', file: 'screens/task/Comments.tsx' },
  ]);
  const commands = reachableBy(rows, {
    kind: 'agent',
    grants: [{ key: 'task:comment', scope: { kind: 'record', id: 'task-1' } }],
  });
  expect(commands.find((one) => one.command === 'task.comment')?.surfaces).toEqual(['API', 'CLI']);
});
