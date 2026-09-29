// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-4, the scope stamp's facts on `task.read`, through the real boundary and
// a fresh Postgres.
//
// A run's scope is the delegation the broker minted when the agent picked the
// work up, named on the lease (R71). `task.read` carries it per lease, read in
// the proposals' one snapshot: the purpose, the one record it was minted for,
// exactly the pairs checked at mint, its term and state, the person whose grants are
// its ceiling, and the grants of theirs it draws on now. Nothing a person edits
// on the task reaches it (R76).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { Controls } from './controls-fixture.ts';
import { checksWorld, pickedUpOn, type PickedUp } from './mp-6-1-checks-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Scope {
  readonly leaseId: string;
  readonly acquiredAt: string;
  readonly delegation: {
    readonly id: string;
    readonly purpose: string;
    readonly scope: { readonly kind: string; readonly id: string };
    readonly pairs: readonly { readonly collection: string; readonly action: string }[];
    readonly grantedAt: string;
    readonly expiresAt: string;
    readonly state: string;
    readonly delegatePersonId: string;
    readonly grants: readonly { readonly id: string; readonly scopeKind: string }[];
  } | null;
}

// eslint-disable-next-line max-lines-per-function -- one business, the scope of the runs on it
describe.skipIf(serverUrl === undefined)('MP-6-4 scope stamp', () => {
  let c: Controls;
  let work: PickedUp;

  beforeAll(async () => {
    ({ c } = await checksWorld('mp_6_4_scope'));
    work = await pickedUpOn(c, 'scoped_work');
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  async function scopesOf(taskId: string): Promise<readonly Scope[]> {
    const read = await c.asPerson('task.read', { recordId: taskId });
    expect(read.status).toBe(200);
    const task = read.body['task'] as { proposals: { scopes: readonly Scope[] }[] };
    return task.proposals[0]?.scopes ?? [];
  }

  async function stored(leaseId: string) {
    const rows = await c.fixture.db.admin.execute<Record<string, unknown>>(
      `select lease.acquired_at, d.id, d.purpose, d.pairs, d.expires_at,
              d.delegate_person_id, d.purpose_scope_id
         from public.leases lease
         join public.delegations d on d.business_id = lease.business_id and d.id = lease.delegation_id
        where lease.id = $1`,
      [leaseId],
    );
    return rows[0] ?? {};
  }

  it('MP-6-4 machine-set stamp', async () => {
    const [scope] = await scopesOf(work.taskId);
    const row = await stored(work.leaseId);
    expect(scope?.leaseId).toBe(work.leaseId);
    expect(scope?.delegation?.id).toBe(row['id']);
    expect(scope?.delegation?.purpose).toBe('scoped_work');
    expect(scope?.delegation?.scope).toStrictEqual({ kind: 'record', id: work.taskId });
    expect(scope?.delegation?.state).toBe('live');
    expect(scope?.delegation?.pairs.map((pair) => pair.action)).not.toContain('decide');
  });

  it('MP-6-4 the snapshot line', async () => {
    const [scope] = await scopesOf(work.taskId);
    const row = await stored(work.leaseId);
    expect(scope?.acquiredAt).toBe(new Date(row['acquired_at'] as Date).toISOString());
  });

  it('MP-6-4 the granted scope facts', async () => {
    const [scope] = await scopesOf(work.taskId);
    const row = await stored(work.leaseId);
    expect(
      scope?.delegation?.pairs.map((pair) => `${pair.collection}:${pair.action}`),
    ).toStrictEqual(row['pairs']);
    expect(scope?.delegation?.expiresAt).toBe(new Date(row['expires_at'] as Date).toISOString());
    expect(scope?.delegation?.delegatePersonId).toBe(c.manager.personId);
    // The grants it draws on: the person's live grants reaching this task, each
    // matching one of its pairs.
    const grants = scope?.delegation?.grants ?? [];
    expect(grants.length).toBeGreaterThan(0);
    const held = await c.fixture.db.admin.execute<{ readonly id: string }>(
      `select id from public.grants
        where subject_kind = 'person' and subject_id = $1 and revoked_at is null
          and (collection || ':' || action) = any ($2::text[])
          and (scope_kind = 'business' or scope_id = $3)`,
      [c.manager.personId, row['pairs'], work.taskId],
    );
    expect(grants.map((grant) => grant.id).toSorted()).toStrictEqual(
      held.map((grant) => grant.id).toSorted(),
    );
  });

  it('MP-6-4 category never changes the stamp', async () => {
    const before = await scopesOf(work.taskId);
    expect(before[0]?.delegation?.grants.length).toBeGreaterThan(0);
    const read = await c.asPerson('task.read', { recordId: work.taskId });
    const revision = (read.body['task'] as { revision: number }).revision;
    // Every field a person may edit on the task, relabelled; the work label
    // (Category, R76) joins them once the task carries it.
    const edited = await c.asPerson('task.update', {
      recordId: work.taskId,
      expectedRevision: revision,
      fields: { title: 'relabelled by a person', description: 'a new description' },
    });
    expect(edited.status).toBe(200);
    expect(await scopesOf(work.taskId)).toStrictEqual(before);
  });
});
