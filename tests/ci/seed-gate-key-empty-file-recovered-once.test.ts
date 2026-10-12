// SPDX-License-Identifier: AGPL-3.0-only
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readEnvFile } from '../../packages/core-records/src/env-file.ts';

type GateKey = { id: string; secret: string; fresh: boolean };

function gateKey(file: string, read: typeof readEnvFile): () => GateKey {
  const script = readFileSync(join(import.meta.dirname, '../../scripts/local-seed.mjs'), 'utf8');
  const source = /^function ensureGateKey\(\) \{\n[\s\S]*?\n\}\n/mu.exec(script)?.[0];
  if (source === undefined) throw new Error('the seed function was not found');
  const scope = { ...fs, ...crypto, gateFile: file, readEnvFile: read };
  const entries = Object.entries(scope).filter(([name]) => name !== 'default');
  return new Function(...entries.map(([name]) => name), `${source}\nreturn ensureGateKey;`)(
    ...entries.map(([, value]) => value),
  );
}

it('two seeds recovering an empty key file retain the first completed signing key', () => {
  const folder = mkdtempSync(join(tmpdir(), 'proof-empty-gate-'));
  try {
    const file = join(folder, 'gate.env');
    writeFileSync(file, '');
    let second: GateKey | undefined;
    let reads = 0;
    const interleave: typeof readEnvFile = (path, options) => {
      const held = readEnvFile(path, options);
      if (++reads === 2) second = gateKey(file, readEnvFile)();
      return held;
    };
    const first = gateKey(file, interleave)();
    expect(reads).toBe(2);
    expect(second?.fresh).toBe(true);
    const durable = readEnvFile(file)['GATE_SIGNING_SECRET'];
    expect(first.secret === durable).toBe(true);
    expect(second?.secret === durable, 'the completed seed must keep a usable signing key').toBe(
      true,
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
