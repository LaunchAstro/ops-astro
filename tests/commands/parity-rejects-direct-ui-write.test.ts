// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

it('rejects a stateful button that posts directly with no command catalogue or CLI equivalent', async () => {
  const path = '../../scripts/command-parity.mjs';
  const { run } = await import(/* @vite-ignore */ path);
  const root = join(process.cwd(), 'apps/web/src');
  const files = new Map(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
      .map((entry) => {
        const file = join(entry.parentPath, entry.name);
        return [relative(root, file), readFileSync(file, 'utf8')];
      }),
  );
  expect(run(files).failures, 'the unchanged application has parity').toEqual([]);
  const file = 'screens/Projects.tsx';
  const source = files.get(file);
  if (!source) throw new Error('the built Projects screen must be present');
  const anchor = '<div className="stack">';
  expect(source).toContain(anchor);
  files.set(
    file,
    source.replace(
      anchor,
      `${anchor}
    <button type="button" onClick={() => { void fetch('/api/b/alpha/unregistered-write', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }); }}>Write an uncatalogued record</button>`,
    ),
  );
  expect(
    run(files).failures,
    'a state-changing UI request without a CLI command must fail parity',
  ).not.toEqual([]);
});
