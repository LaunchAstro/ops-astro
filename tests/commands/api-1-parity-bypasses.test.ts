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

it('a double-quoted stateful action fails parity', () => {
  const files = new Map([
    [
      'screen-registry.tsx',
      "import { Detail } from './screens/Detail.tsx';\n  'agency:task-detail': () => <Detail />",
    ],
    [
      'screens/Detail.tsx',
      'const onClick = () => client.mutate("task.nudge", {}, { operationId: "x" });',
    ],
  ]);
  const { failures } = run(files);
  expect(failures).toContain(
    'the app action task.nudge at agency:task-detail (screens/Detail.tsx) has no CLI verb',
  );
});

it('a CLI verb redirected past its grant fails parity', () => {
  const copy = mkdtempSync(join(tmpdir(), 'sol-api-1-'));
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

    const cliPath = join(copy, 'apps/cli/client.ts');
    const original = readFileSync(cliPath, 'utf8');
    const redirected = original.replace(
      'pathOf(verb as CommandName)',
      "pathOf((verb === 'task.assign' ? 'task.update' : verb) as CommandName)",
    );
    expect(redirected).not.toBe(original);
    writeFileSync(cliPath, redirected);

    const routed = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { createCli } from './apps/cli/client.ts'; const cli = createCli({ businessKey: 'alpha', credential: 'unused', transport: async (path) => { process.stdout.write(path); return new Response('{}', { status: 200 }); } }); await cli.run('task.assign', {});",
      ],
      { cwd: copy, encoding: 'utf8', timeout: 30_000 },
    );
    expect(routed.status, routed.stderr).toBe(0);
    expect(routed.stdout).toBe('/api/b/alpha/task/update');

    const result = parity();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain('task.assign');
    expect(result.stdout).toContain('task:assign');
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

it('a record grant does not make business-wide create reachable', () => {
  const recordWriter = {
    kind: 'person' as const,
    keys: new Set(['task:write']),
    grants: [{ key: 'task:write', scope: { kind: 'record' as const, id: 'own-task' } }],
    member: true,
  };
  const available = reachableBy(buildCatalogue([]), recordWriter);
  expect(available.map((one) => one.command)).not.toContain('task.create');
});
