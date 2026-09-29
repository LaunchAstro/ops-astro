// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { identityDefects, migrationHead, type IdentityEvidence } from '../../apps/api/identity.ts';
import { main as workerMain } from '../../apps/worker/main.ts';

describe('T2b served identity', () => {
  it('Sol proof, criterion 2: the web origin cannot hide a different API tree behind the same pid', () => {
    const tree = 'a'.repeat(40);
    const head = migrationHead([{ version: '0001', checksum: 'a' }]);
    const api = {
      commit: 'b'.repeat(40),
      tree,
      dirty: [],
      pid: 1,
      checkout: '/work/api',
      migrationHead: head,
    };
    const evidence: IdentityEvidence = {
      api,
      apiViaWeb: { ...api, tree: 'c'.repeat(40) },
      web: { ...api, checkout: '/work/web' },
      evidenceTree: tree,
      migrationFiles: head,
    };

    expect(identityDefects(evidence)).not.toStrictEqual([]);
  });
});

describe('T2b isolation evidence', () => {
  it('Sol proof, criterion 3: T2b names business, client and person crossover tests', () => {
    const source = readFileSync(new URL('./t2b-worker.test.ts', import.meta.url), 'utf8');
    const names = [...source.matchAll(/\bit\(['"`]([^'"`]+)['"`]/gu)].map((match) => match[1]);
    for (const boundary of ['business to business', 'client to client', 'person to person']) {
      expect(
        names.some((name) => name?.includes(`T2 isolation: ${boundary}`)),
        boundary,
      ).toBe(true);
    }
  });
});

describe('T2b credential output', () => {
  it('Sol proof, criterion 3: transport failures never print an agent credential or delegation', async () => {
    const token = 'canary-agent-credential';
    const delegation = 'canary-dispatch-token';
    const originalFetch = globalThis.fetch;
    const originalWrite = process.stderr.write;
    const output: string[] = [];
    globalThis.fetch = async () => {
      throw new Error(`transport failed with ${token} and ${delegation}`);
    };
    process.stderr.write = ((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(
        await workerMain(['--once'], {
          OPS_ASTRO_BUSINESS: 'alpha',
          OPS_ASTRO_TOKEN: token,
          OPS_ASTRO_DELEGATION: delegation,
        }),
      ).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
      process.stderr.write = originalWrite;
    }
    expect(output.join('')).not.toContain(token);
    expect(output.join('')).not.toContain(delegation);
  });
});
