// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runSuite } from './api-2-quota-mutant-suite.mjs';

test('the per-business quota cases detect business to business interference', () => {
  const prelude = `
import { vi } from 'vitest';
vi.mock('../../apps/api/auth/agent-quota.ts', async (original) => {
  const real = await original<typeof import('../../apps/api/auth/agent-quota.ts')>();
  return {
    ...real,
    createAgentQuota: (...args: Parameters<typeof real.createAgentQuota>) => {
      const quota = real.createAgentQuota(...args);
      return {
        ...quota,
        enter: (keys: Parameters<typeof quota.enter>[0]) =>
          quota.enter({ ...keys, businessId: 'sol-global-business' }),
      };
    },
  };
});
`;
  const suffix = `
import { issue, issueBody, detailOf } from './api-2-agent-credential-world.ts';
import { asCredential } from './api-2-agent-credential-use-world.ts';

async function bravoSecret(): Promise<string> {
  const answer = await issue(issueBody(READ_ONLY), harness.world.bea.token, 'bravo');
  expect(answer.code, 'Bravo can issue a read credential').toBe('ok');
  return String(detailOf(answer)['credential']);
}

needsServer('Sol mutant witness: Alpha in flight incorrectly refuses Bravo', async () => {
  const pool = widePool();
  try {
    const alpha = await issued();
    const bravo = await bravoSecret();
    const { api } = limited({ concurrent: { ...WIDE, business: 1 } }, pool);
    const readBravo = () => asCredential('task.read', { recordId: harness.bravoRecordId }, bearer(bravo), api, 'bravo');
    expect((await readBravo()).code, 'Bravo can read before Alpha fills its quota').toBe('ok');
    const { probed, held } = await whileHeld(api, alpha.secret, readBravo);
    expect(probed.code, 'the injected global counter blocks a separate business').toBe('AGENT_QUOTA_EXCEEDED');
    expect(held.code).toBe('ok');
  } finally {
    await pool.close();
  }
});

needsServer('Sol mutant witness: Alpha exports incorrectly refuse Bravo', async () => {
  const alpha = await issued();
  const bravo = await bravoSecret();
  const control = limited({ exports: { ...WIDE, business: 2 } }).api;
  expect((await asCredential('task.read', { recordId: harness.bravoRecordId }, bearer(bravo), control, 'bravo')).code).toBe('ok');
  const { api } = limited({ exports: { ...WIDE, business: 2 } });
  expect((await readWith(api, alpha.secret)).code).toBe('ok');
  expect((await readWith(api, alpha.secret)).code).toBe('ok');
  const answer = await asCredential('task.read', { recordId: harness.bravoRecordId }, bearer(bravo), api, 'bravo');
  expect(answer.code, 'the injected global counter blocks a separate business').toBe('AGENT_QUOTA_EXCEEDED');
});
`;
  const { child, cases } = runSuite('business-mutant', prelude, suffix,
    'API-2 quota|Sol mutant witness');
  const witnesses = cases.filter((one) => one.fullName.startsWith('Sol mutant witness'));
  assert.equal(witnesses.length, 2);
  assert.ok(witnesses.every((one) => one.status === 'passed'),
    'Both API witnesses must establish the actual cross-business fault');
  const named = cases.filter((one) => /^API-2 quota (in flight|on export) per business/u.test(one.fullName) && ['passed', 'failed'].includes(one.status));
  assert.equal(named.length, 2);
  assert.notEqual(child.status, 0,
    'Both named per-business cases passed even though Alpha throttled Bravo; add a named business to business admission control to each case');
});
