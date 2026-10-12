// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { isolationWorld, serverUrl } from './mp-3-1-isolation-world.tsx';

const w = isolationWorld('sol1476clients');

it.skipIf(serverUrl === undefined)(
  'MP-3-1 isolation: the client crossing links its tasks to two distinct stored clients',
  async () => {
    const rows = await w.fixture.db.admin.execute<{ client: string | null }>(
      `select r.uuid_7::text as client from public.records r
       join public.grants g on g.scope_id = r.id and g.business_id = r.business_id
      where g.scope_kind = 'record' and g.collection = 'task' and g.action = 'read'
        and g.subject_id = any($1::uuid[]) and r.business_id = $2`,
      [[w.clientOne.personId, w.clientTwo.personId], w.fixture.business],
    );
    expect(rows).toHaveLength(2);
    expect(
      new Set(rows.flatMap(({ client }) => (client === null ? [] : [client]))).size,
    ).toBeGreaterThanOrEqual(2);
  },
);
