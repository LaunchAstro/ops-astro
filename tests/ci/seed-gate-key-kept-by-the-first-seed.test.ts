// SPDX-License-Identifier: AGPL-3.0-only
//
// The seed's decision signing key is generated once and read back. Two first
// seeds that both find no key must still end holding one: a second seed that
// overwrote the first's would leave every decision the API signed under the
// first key unverifiable after a restart. The seed script runs end to end only
// against a database, so its own `ensureGateKey` is read out of the file and run
// here against a real folder, with the first seed paused right after its read
// while the second runs whole.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readEnvFile } from '../../packages/core-records/src/env-file.ts';

type GateKey = { id: string; secret: string; fresh: boolean };

const SEED = readFileSync(join(import.meta.dirname, '../../scripts/local-seed.mjs'), 'utf8');
const SOURCE = /^function ensureGateKey\(\) \{\n[\s\S]*?\n\}\n/mu.exec(SEED)?.[0] ?? '';

/** The seed's own function, over `gateFile` and the reader given. */
function ensureGateKey(gateFile: string, read: typeof readEnvFile): () => GateKey {
  const scope = { ...fs, ...crypto, gateFile, readEnvFile: read };
  const names = Object.keys(scope).filter((name) => name !== 'default');
  const values = names.map((name) => scope[name as keyof typeof scope]);
  return new Function(...names, `${SOURCE}\nreturn ensureGateKey;`)(...values) as () => GateKey;
}

it('two first seeds at once keep the one decision signing key the first wrote', () => {
  expect(SOURCE).not.toBe('');
  const folder = mkdtempSync(join(tmpdir(), 'seed-gate-key-'));
  try {
    const file = join(folder, 'gate.env');
    let second: GateKey | undefined;
    let reads = 0;
    const pausedAfterRead: typeof readEnvFile = (path, options) => {
      const held = readEnvFile(path, options);
      if (++reads === 1) second = ensureGateKey(file, readEnvFile)();
      return held;
    };
    const first = ensureGateKey(file, pausedAfterRead)();

    const kept = readEnvFile(file)['GATE_SIGNING_SECRET'];
    expect(second?.secret).toBe(kept);
    expect(first.secret).toBe(kept);
    expect(first.id).toBe(second?.id);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
