// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-2, the Agent page's facts on `task.read`, through the real boundary and
// a fresh Postgres.
//
// The hero's "to the gate" is the time from the run's start to the gate the
// run handed back for review. Both ends are stored facts, read in the
// proposals' one snapshot: the run's start is the first lease taken on it,
// and a gate's raised time is its own row's. The page is a read: opening it
// writes the read's one audit event and
// nothing more (TR-S-B3-1, under the standing rule that every read is audited).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { Controls } from './controls-fixture.ts';
import { checksWorld, pickedUpOn, type PickedUp } from './mp-6-1-checks-fixture.ts';
import { handBack } from './mp-6-2-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Version {
  readonly versionId: string;
  readonly version: number;
  readonly runStartedAt: string | null;
  readonly gate: { readonly id: string; readonly raisedAt: string } | null;
}

// eslint-disable-next-line max-lines-per-function -- one business, one handed-back run on it
describe.skipIf(serverUrl === undefined)('MP-6-2 agent page', () => {
  let c: Controls;
  let work: PickedUp;

  beforeAll(async () => {
    ({ c } = await checksWorld('mp_6_2_page'));
    work = await pickedUpOn(c, 'page_run');
    const checked = await c.asAgent(
      'task.check',
      { leaseId: work.leaseId, fence: work.fence, name: 'links resolve', outcome: 'passed' },
      work.credential,
    );
    expect(checked.status).toBe(200);
    await handBack(c, work);
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  async function versions(): Promise<readonly Version[]> {
    const read = await c.asPerson('task.read', { recordId: work.taskId });
    expect(read.status).toBe(200);
    const task = read.body['task'] as { proposals: { versions: readonly Version[] }[] };
    return task.proposals[0]?.versions ?? [];
  }

  it('MP-6-2 hero stats', async () => {
    const [head, first] = await versions();
    const stored = await c.fixture.db.admin.execute<{
      readonly acquired_at: Date;
      readonly raised_at: Date;
    }>(
      `select (select acquired_at from public.leases where id = $1) as acquired_at,
              (select g.created_at from public.gates g where g.id = $2) as raised_at`,
      [work.leaseId, head?.gate?.id],
    );
    expect(first?.versionId).toBe(work.versionId);
    expect(first?.runStartedAt).toBe(stored[0]?.acquired_at.toISOString());
    expect(head?.version).toBe(2);
    expect(head?.runStartedAt).toBeNull();
    expect(head?.gate?.raisedAt).toBe(stored[0]?.raised_at.toISOString());
    expect(Date.parse(head?.gate?.raisedAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(first?.runStartedAt ?? ''),
    );
  });

  // Every read writes its one audit event, `task.read`'s own (the standing
  // rule). What the page draws from it (hero, artefacts, log, side column)
  // adds none: two opens are two events, both the read's.
  it('MP-6-2 no audit event beyond task.read’s own', async () => {
    const events = async (): Promise<readonly string[]> =>
      (
        await c.fixture.db.admin.execute<{ readonly id: string; readonly command: string }>(
          `select id, command from public.audit_events where business_id = $1 order by seq`,
          [c.fixture.business],
        )
      ).map((row) => `${row.id} ${row.command}`);
    const before = await events();
    await versions();
    await versions();
    const after = await events();
    expect(after.slice(0, before.length)).toStrictEqual(before);
    expect(after.slice(before.length).map((row) => row.split(' ')[1])).toStrictEqual([
      'task.read',
      'task.read',
    ]);
  });
});
