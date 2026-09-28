// SPDX-License-Identifier: AGPL-3.0-only
//
// The served-identity check (T2b, product issue 11, spike RN-03), its pure
// half: what counts as a defect in the evidence a served proof records, and
// who may read the route. The route itself, over a composed API with a real
// ledger, is in `tests/api/t2b-worker.test.ts` (`T2 identity local`).

import { describe, expect, it } from 'vitest';
import {
  identityDefects,
  isLoopback,
  migrationHead,
  readIdentity,
  type IdentityEvidence,
} from '../../apps/api/identity.ts';

const clean = {
  commit: 'c'.repeat(40),
  tree: 't'.repeat(40),
  dirty: [],
  pid: 4242,
  checkout: '/work/ops-astro',
} as const;

const HEAD = migrationHead([
  { version: '0001_a', checksum: 'aa' },
  { version: '0002_b', checksum: 'bb' },
]);

const good: IdentityEvidence = {
  api: { ...clean, migrationHead: HEAD },
  apiViaWeb: { ...clean, migrationHead: HEAD },
  web: { ...clean, pid: 5151 },
  evidenceTree: clean.tree,
  migrationFiles: HEAD,
};

describe('the served-identity check', () => {
  it('finds nothing wrong with one clean tree, one API process and the ledger at the files', () => {
    expect(identityDefects(good)).toStrictEqual([]);
  });

  it('defect: an API serving an older tree', () => {
    const defects = identityDefects({ ...good, api: { ...good.api, tree: 'o'.repeat(40) } });
    expect(defects.join('\n')).toMatch(/API tree/u);
  });

  it('defect: an uncommitted web edit with no restart', () => {
    const defects = identityDefects({
      ...good,
      web: { ...good.web, dirty: ['apps/web/src/x.tsx'] },
    });
    expect(defects.join('\n')).toMatch(/web .*apps\/web\/src\/x\.tsx/u);
  });

  it('defect: an API started from a dirty tree and cleaned later keeps reporting dirty', () => {
    const defects = identityDefects({
      ...good,
      api: { ...good.api, dirty: ['packages/core-runtime/src/propose.ts'] },
    });
    expect(defects.join('\n')).toMatch(/API .*dirty/u);
  });

  it('defect: the web origin reaches a different API process', () => {
    const defects = identityDefects({ ...good, apiViaWeb: { ...good.apiViaWeb, pid: 1 } });
    expect(defects.join('\n')).toMatch(/process/u);
  });

  it('defect: the ledger is not at the migration files of the evidence head', () => {
    const behind = migrationHead([{ version: '0001_a', checksum: 'aa' }]);
    const defects = identityDefects({ ...good, api: { ...good.api, migrationHead: behind } });
    expect(defects.join('\n')).toMatch(/migration head/u);
  });

  it('the migration head is a digest over the ordered version and checksum pairs', () => {
    const swapped = migrationHead([
      { version: '0002_b', checksum: 'bb' },
      { version: '0001_a', checksum: 'aa' },
    ]);
    expect(swapped).toBe(HEAD);
    expect(migrationHead([{ version: '0001_a', checksum: 'ab' }])).not.toBe(
      migrationHead([{ version: '0001_a', checksum: 'aa' }]),
    );
  });

  it('reads this checkout: commit, tree, tracked dirty paths only, pid', () => {
    const identity = readIdentity(process.cwd());
    expect(identity.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(identity.tree).toMatch(/^[0-9a-f]{40}$/u);
    expect(identity.pid).toBe(process.pid);
    expect(identity.dirty.every((path) => !path.startsWith('.local/'))).toBe(true);
  });

  it('T2 identity local: loopback means 127.0.0.1 and ::1, and nothing else', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    for (const address of ['10.0.0.2', '192.168.1.5', '::ffff:10.0.0.2', '', undefined]) {
      expect(isLoopback(address)).toBe(false);
    }
  });
});
