// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFunctionHandler } from '../../apps/api/function.ts';
import {
  passDeployment,
  registerEffectLookup,
  SWEEP_INTERVAL_MS,
} from '../../apps/api/recovery-entry.ts';
import { loginIn } from '../db/backup-identity.fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { TEST_ISSUER } from '../support/sign-in.ts';
import { liveWork, openSchedules } from '../runtime/schedules-harness.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)('recovery in the hosted entry', () => {
  it('fences a lost workers expired lease while the deployed function keeps serving', async () => {
    const s = await openSchedules('hostedrecovery', 100_000);
    try {
      const work = await liveWork(s, 'A worker lost before dispatch', 1000);
      await s.db.admin.execute(
        "update public.leases set expires_at = now() - interval '1 minute' where id = $1",
        [work.picked['leaseId']],
      );
      const keyId = 'test/hosted-recovery@1';
      const handle = createFunctionHandler({
        DATABASE_URL: s.db.appUrl,
        DATABASE_LOOKUP_URL: (await loginIn(s.db, 'ops_astro_lookup', 'hr')).url,
        GOTRUE_URL: TEST_ISSUER,
        SERVED_HOST: 'ops.example.test',
        GATE_SIGNING_KEY_ID: process.env['GATE_SIGNING_KEY_ID'],
        GATE_SIGNING_SECRET: process.env['GATE_SIGNING_SECRET'],
        DELEGATION_CREDENTIAL_KEY_ID: keyId,
        DELEGATION_CREDENTIAL_KEYS: `${keyId}:${randomBytes(32).toString('base64url')}`,
        RECOVERY_BUSINESS_KEYS: 'schedules-hostedrecovery',
      });
      const state = async () =>
        (
          await s.db.admin.execute<{ state: string }>(
            'select state from public.leases where id = $1',
            [work.picked['leaseId']],
          )
        )[0]?.state;
      const deadline = Date.now() + SWEEP_INTERVAL_MS + 5_000;
      while (Date.now() < deadline && (await state()) === 'live') {
        const response = await handle(
          new Request('https://ops.example.test/api/health', {
            headers: { host: 'ops.example.test' },
          }),
        );
        expect(response.status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const hostedState = await state();
      const control = await passDeployment(
        s.db.app,
        async () => s.business,
        ['schedules-hostedrecovery'],
        registerEffectLookup,
      );
      expect(control.ok).toBe(true);
      expect(await state(), 'the existing recovery pass can fence this lease').toBe('expired');
      expect(hostedState, 'the hosted topology must run the recovery pass').toBe('expired');
    } finally {
      await s.db.drop();
    }
  }, 90_000);

  // #287 A8: the scope names a key that resolves to nothing, ahead of a real one.
  it('one business key that does not resolve leaves the pass running for the other businesses', async () => {
    const s = await openSchedules('hostedunresolved', 100_000);
    try {
      const work = await liveWork(s, 'A worker lost beside a stale key', 1000);
      const lease = work.picked['leaseId'];
      await s.db.admin.execute(
        "update public.leases set expires_at = now() - interval '1 minute' where id = $1",
        [lease],
      );
      const keyId = 'test/hosted-unresolved@1';
      const handle = createFunctionHandler({
        DATABASE_URL: s.db.appUrl,
        DATABASE_LOOKUP_URL: (await loginIn(s.db, 'ops_astro_lookup', 'hu')).url,
        GOTRUE_URL: TEST_ISSUER,
        SERVED_HOST: 'ops.example.test',
        DELEGATION_CREDENTIAL_KEY_ID: keyId,
        DELEGATION_CREDENTIAL_KEYS: `${keyId}:${randomBytes(32).toString('base64url')}`,
        RECOVERY_BUSINESS_KEYS: 'no-such-business,schedules-hostedunresolved',
      });
      // The request waits on the pass, so one is enough.
      const response = await handle(
        new Request('https://ops.example.test/api/health', {
          headers: { host: 'ops.example.test' },
        }),
      );
      expect(response.status).toBe(200);
      const [row] = await s.db.admin.execute<{ state: string }>(
        'select state from public.leases where id = $1',
        [lease],
      );
      expect(row?.state).toBe('expired');
    } finally {
      await s.db.drop();
    }
  }, 90_000);
});
