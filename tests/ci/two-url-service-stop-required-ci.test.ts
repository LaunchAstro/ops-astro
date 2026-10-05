// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { readIsolationSuites, readNamedSuites } from '../../scripts/named-suites.ts';

const proof = 'tests/ci/named-service-stop-proof-two-urls.test.ts';
const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const manifest = readNamedSuites(process.cwd());
const named = new Set([...manifest.invariant, ...manifest.conformance]);
const isolation = new Set(readIsolationSuites(process.cwd()).invariant);

function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start === -1) return '';
  const next = workflow.slice(start + 1).search(/\n {2}[\w-]+:\n/u);
  return workflow.slice(start + 1, next === -1 ? undefined : start + next + 2);
}

const withBothUrls = (block: string): boolean =>
  block.includes('DATABASE_URL:') && block.includes('DATABASE_ADMIN_URL:');

it('the two-URL service-stop regression proof runs in required CI', () => {
  const check = job('check');
  const shard = job('database-shard');
  const isolated = job('isolation');
  const direct = [check, shard, isolated].some(
    (block) => withBothUrls(block) && block.includes(proof),
  );
  const throughCheck = withBothUrls(check) && check.includes('run: pnpm check');
  const throughManifest =
    (named.has(proof) && withBothUrls(shard)) ||
    (isolation.has(proof) && withBothUrls(isolated));
  expect(direct || throughCheck || throughManifest).toBe(true);
});
