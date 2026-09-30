// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createHarness } from './role-case-harness.ts';
import type { Harness } from './role-case-harness-shape.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)('T4e N2 fixture proof', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness('sol_t4e_n2');
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('Sol proof, criterion 3: the N2 matrix has T4a’s two clients and one record grant each in both businesses', async () => {
    const rows = await harness.world.db.admin.execute<{
      business: string;
      clients: string;
      grants: string;
    }>(`select b.key business,
          count(distinct p.id)::text clients,
          count(distinct g.id)::text grants
        from public.businesses b
        left join public.people p on p.business_id = b.id
          and p.display_name like b.key || '-client-%'
        left join public.grants g on g.business_id = b.id
          and g.subject_kind = 'person' and g.subject_id = p.id
          and g.scope_kind = 'record' and g.action = 'read' and g.revoked_at is null
        group by b.key order by b.key`);
    expect(rows).toStrictEqual([
      { business: 'alpha', clients: '2', grants: '2' },
      { business: 'bravo', clients: '2', grants: '2' },
    ]);
  });
});
