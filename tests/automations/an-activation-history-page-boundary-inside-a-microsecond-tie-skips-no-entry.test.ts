// SPDX-License-Identifier: AGPL-3.0-only
//
// A page boundary that falls inside entries recorded at the same microsecond
// skips none of them: the next page starts exactly after the last entry given.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRegistryWorld, type RegistryWorld } from './registry-world.ts';
import { historyPage, scheduledOnFirst } from './history-world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('an activation history page boundary', () => {
  let w: RegistryWorld;
  beforeAll(async () => {
    w = await createRegistryWorld('historytie');
  }, 120_000);
  afterAll(async () => {
    await w?.drop();
  });
  it('a page boundary inside entries tied to the microsecond skips none of them', async () => {
    const { activationId, first } = await scheduledOnFirst(w);
    await w.controls.fixture.db.admin.execute(
      `insert into public.activation_occurrences
    (business_id,id,activation_id,version_id,due_at,outcome,recorded_at)
    select $1,gen_random_uuid(),$2,$3,timestamptz '2025-01-01' + g * interval '1 hour',
      'no_standing_approval',timestamptz '2026-01-01T00:00:00.123456Z'
    from generate_series(1,51) g`,
      [w.alpha, activationId, first],
    );
    const page1 = await historyPage(w, w.admin, activationId);
    expect(page1.entries).toHaveLength(50);
    expect(page1.next).not.toBeNull();
    const page2 = await historyPage(w, w.admin, activationId, page1.next!);
    const ids = [...page1.entries, ...page2.entries].map((e) => e.id);
    expect(new Set(ids).size).toBe(52);
  });
});
