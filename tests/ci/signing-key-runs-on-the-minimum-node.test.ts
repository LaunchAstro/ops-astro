// SPDX-License-Identifier: AGPL-3.0-only
//
// The local signing-key generator prints a key when run as a script, on every
// Node the repository admits. `engines` says >=24, and Node 24.0.0 has no
// `import.meta.main`, so the generator must not depend on it.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '../../scripts/local/signing-key.mjs');

describe('the signing-key generator', () => {
  it('decides it runs as a script without import.meta.main', () => {
    expect(readFileSync(SCRIPT, 'utf8')).not.toContain('import.meta.main');
  });

  it('prints one ES256 key when run', () => {
    const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    const [key, ...others] = JSON.parse(run.stdout) as { alg: string }[];
    expect([key?.alg, others.length]).toStrictEqual(['ES256', 0]);
  });
});
