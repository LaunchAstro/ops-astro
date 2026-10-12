// SPDX-License-Identifier: AGPL-3.0-only
//
// The local trace target's settings hold its generated secrets, so the file
// is readable by its owner only, even when a looser file was there before.

import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runSettings } from '../../scripts/local/trace-target.ts';

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("an existing world-readable settings file is owner-only once the target's secrets are written", () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-target-'));
  made.push(dir);
  const file = join(dir, 'trace-target.env');
  writeFileSync(file, 'stale\n', { mode: 0o644 });
  expect(statSync(file).mode & 0o777).toBe(0o644);

  runSettings(3910, file);

  expect(statSync(file).mode & 0o777).toBe(0o600);
});
