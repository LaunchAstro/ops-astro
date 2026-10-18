// SPDX-License-Identifier: AGPL-3.0-only
//
// The streamed timeout proof must fail when the timeout leaves a descendant
// alive. Run under a planted fault that kills the child alone, never its group
// (parent-only-kill.setup.ts), the proof has to refuse, and for that reason:
// the review of #1756 found it checked only that the call completed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const PROOF =
  'tests/local-agent/a-streamed-call-ends-at-its-timeout-and-charges-nothing-before-its-turn.test.ts';

it('the timeout proof refuses a timeout that leaves a descendant holding the pipe alive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parent-only-kill-'));
  try {
    const config = join(dir, 'parent-only-kill.config.mts');
    writeFileSync(
      config,
      `import base from ${JSON.stringify(join(ROOT, 'vitest.config.ts'))};
export default {
  ...base,
  root: ${JSON.stringify(ROOT)},
  test: {
    ...base.test,
    setupFiles: [...(base.test?.setupFiles ?? []), 'tests/local-agent/parent-only-kill.setup.ts'],
  },
};
`,
    );
    const run = spawnSync(
      process.execPath,
      [
        join(ROOT, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        config,
        PROOF,
        '--testNamePattern=cannot block the runner',
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 60_000 },
    );
    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.status, output).not.toBe(0);
    expect(output).toContain('the timeout stopped the descendant holding the pipe');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 90_000);
