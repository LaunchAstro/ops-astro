// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, expect, vi } from 'vitest';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';

const observed = vi.hoisted(() => ({ corruptions: 0 }));

// Run the exact named C31 test against real rows whose hashes are deliberately wrong.
vi.mock('../api/controls-fixture.ts', async (original) => {
  const actual = await original<typeof import('../api/controls-fixture.ts')>();
  const createControls: typeof actual.createControls = async (...args) => {
    const controls = await actual.createControls(...args);
    const fetch = controls.api.fetch.bind(controls.api);
    controls.api.fetch = async (...request) => {
      const response = await fetch(...request);
      const url = new URL(request[0].url);
      if (url.pathname.endsWith('/secret/set') || url.pathname.endsWith('/secret/clear')) {
        const { db, business } = controls.fixture;
        await db.admin.execute('alter table public.audit_events disable trigger audit_append_only');
        try {
          await db.admin.execute(
            `update public.audit_events set hash = repeat('0', 64)
              where business_id = $1 and command in ('secret.set', 'secret.clear')`,
            [business],
          );
        } finally {
          await db.admin.execute(
            'alter table public.audit_events enable trigger audit_append_only',
          );
        }
        const report = await db.app.withBusiness(business, verifyAuditChain);
        expect(report.intact, 'the mutation must really break the stored chain').toBe(false);
        observed.corruptions += 1;
      }
      return response;
    };
    return controls;
  };
  return { ...actual, createControls };
});

import './c31-credentials.test.ts';

afterAll(() => {
  console.log(`Sol audit mutation count: ${observed.corruptions}`);
});
