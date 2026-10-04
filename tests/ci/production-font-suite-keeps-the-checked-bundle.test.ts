// SPDX-License-Identifier: AGPL-3.0-only
//
// Under `pnpm check` other test workers copy apps/web/dist while the
// production-font suite runs. Handed the stamp of the bundle the check built
// (CHECK_WEB_BUILD), that suite must leave the bundle as it found it: a
// rebuild empties the directory under the readers.
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { readStamp } from '../../apps/web/build-stamp.ts';
import { needsBuild } from './web-bundle-build.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const DIST = join(ROOT, 'apps/web/dist');

it('the production-font suite preserves the bundle already built for concurrent readers', () => {
  if (needsBuild(DIST, process.env['CHECK_WEB_BUILD'])) {
    const built = spawnSync('corepack', ['pnpm', 'build'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(built.status, built.stdout + built.stderr).toBe(0);
  }
  const stamp = readStamp(DIST);
  expect(stamp).toBeDefined();
  expect(needsBuild(DIST, stamp)).toBe(false);

  // A reader can hold any existing asset when the test workers start.
  // Removing this one proves the check-owned directory was emptied again.
  const asset = join(DIST, 'assets/sol-check-owned.js');
  writeFileSync(asset, 'export const owned = true;\n');
  try {
    const font = spawnSync(
      'corepack',
      [
        'pnpm',
        'exec',
        'vitest',
        'run',
        'tests/surfaces/fonts-forward-pair-and-production-woff2.test.ts',
      ],
      {
        cwd: ROOT,
        env: { ...process.env, CHECK_WEB_BUILD: stamp },
        encoding: 'utf8',
        timeout: 180_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    expect(font.status, font.stdout + font.stderr).toBe(0);
    expect(
      existsSync(asset),
      'the real production-font suite emptied apps/web/dist despite CHECK_WEB_BUILD; other workers can read or copy it during that rebuild',
    ).toBe(true);
  } finally {
    rmSync(asset, { force: true });
  }
}, 300_000);
