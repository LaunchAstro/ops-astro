// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

it(
  'Sol proof, criterion same-claims: the coloured check rejects a wrapper that skips under colour',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'skipped-wrapper-'));
    try {
      const archive = spawnSync('git', ['archive', 'HEAD'], {
        cwd: root,
        maxBuffer: 32 * 1024 * 1024,
      });
      expect(archive.status, archive.stderr.toString()).toBe(0);
      const extracted = spawnSync('tar', ['-x', '-C', directory], { input: archive.stdout });
      expect(extracted.status, extracted.stderr.toString()).toBe(0);
      symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');

      // The wrapper regresses to the bug the coloured check exists for: with
      // colour forced it no longer runs the capture, it skips.
      const wrapper = join(directory, 'tests/visual/harness-capture-needs-browser.test.ts');
      const source = readFileSync(wrapper, 'utf8');
      const start = 'CI without one fails\', async (context) => {\n';
      expect(source).toContain(start);
      writeFileSync(
        wrapper,
        source.replace(
          start,
          `${start}  if ((process.env['FORCE_COLOR'] ?? '') !== '') context.skip('coloured summary');\n`,
        ),
      );

      const run = spawnSync(
        process.execPath,
        [
          join(directory, 'node_modules/vitest/vitest.mjs'),
          'run',
          'tests/visual/browser-proof-coloured-summary.test.ts',
        ],
        { cwd: directory, encoding: 'utf8' },
      );
      expect(run.status, `${run.stdout}\n${run.stderr}`).not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
