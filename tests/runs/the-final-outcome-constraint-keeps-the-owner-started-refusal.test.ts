// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { mayCarry } from '../../packages/core-custody/src/carry-rule.ts';
import { outcomeOf } from '../../packages/core-wire/src/run-outcomes.ts';

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' });

it('the final outcome constraint accepts the owner-started plan refusal, which ends the attempt cancelled', () => {
  const refusal = mayCarry('subscription', {
    unattended: true,
    sessionPersonId: null,
    workForPersonId: null,
    tenantInstallation: 'here',
    credentialInstallation: 'here',
    planRoute: true,
    ownerStarted: false,
  });
  expect(refusal).toEqual({ ok: false, code: 'SUBSCRIPTION_NOT_OWNER_STARTED' });
  if (refusal.ok) throw new Error('control: expected refusal');
  expect(outcomeOf(refusal.code)).toBe('cancelled');
  const revision = process.env['SOL_MIGRATION_REV'] ?? 'HEAD';
  const files = git('ls-tree', '-r', '--name-only', revision, '--', 'migrations')
    .trim()
    .split('\n')
    .filter((p) => p.endsWith('.sql'))
    .toSorted();
  let cancelled: string[] | undefined;
  let last = '';
  for (const file of files) {
    const sql = git('show', `${revision}:${file}`);
    const constraint = sql.match(
      /(?:add\s+)?constraint\s+run_outcomes_end_code_of_outcome\s+check\s*\(([\s\S]*?);/iu,
    );
    if (!constraint) continue;
    const branch = constraint[1]?.match(
      /outcome\s*=\s*'cancelled'\s+and\s+end_code\s+in\s*\(([^)]*)\)/iu,
    );
    expect(branch, file).toBeDefined();
    cancelled = [...(branch?.[1] ?? '').matchAll(/'([^']+)'/gu)].map((m) => m[1]!);
    last = file;
  }
  expect(cancelled, `${revision}: ${last} must retain the reachable base refusal`).toContain(
    refusal.code,
  );
});
