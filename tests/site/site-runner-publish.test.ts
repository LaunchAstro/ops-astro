// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner (#1692) proposing and publishing, on the site doubles and a
// real database: an approved correction proposed, published once, checked live
// and receipted; an unapproved one, or one on another task than its lease,
// sending nothing; a runner restarted on a new connection and lease observing
// again, never sending twice.

import { describe, expect, it } from 'vitest';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { PAGE, requestBody } from './c80-world.ts';
import { detailOf } from '../commands/agent-fixture.ts';
import {
  approved,
  entries,
  handBack,
  lease,
  receipt,
  serverUrl,
  takeOver,
  w,
} from './c80-register-world.ts';
import {
  building,
  built,
  merges,
  runnerOn,
  useRunnerWorld,
  world,
  writes,
} from './site-runner-world.ts';

useRunnerWorld();

describe.skipIf(serverUrl === undefined)('the site runner, publishing', () => {
  it('proposes and publishes an approved correction once, checks it live and writes its receipts', async () => {
    const id = await approved();
    const given = world();
    const { runner, released } = runnerOn(id, given);

    expect(await runner.pass()).toEqual([{ correctionId: id, outcome: 'live' }]);

    expect(merges(given.site)).toHaveLength(1);
    expect(await w.stateOf(id)).toBe('live');
    const publish = await receipt(id, 'publish');
    // Captured before the send and again once live, the agency page and nothing else.
    expect(given.captured.length).toBeGreaterThanOrEqual(2);
    expect(given.captured.every((href) => href === PAGE)).toBe(true);
    expect(publish['deployment_served']?.observed).toBe('served');
    expect(publish['live_occurrence']?.observed).toContain('welcoming');
    expect(publish['pre_image_digest']?.observed).toMatch(/\S/u);
    expect(released).toEqual([id]);
    // A second pass has nothing left to take and sends nothing.
    const sent = writes(given.site).length;
    expect(await runner.pass()).toEqual([]);
    expect(writes(given.site)).toHaveLength(sent);
  });

  it('sends nothing for a correction nobody approved', async () => {
    const detail = detailOf(await w.request(w.ava, { taskId: lease.taskId }));
    const id = String(detail['correctionId']);
    const given = world();
    const { runner, released } = runnerOn(id, given);

    expect(await runner.pass()).toEqual([{ correctionId: id, outcome: 'APPROVAL_MISSING' }]);
    expect(writes(given.site)).toHaveLength(0);
    expect(await w.receiptsOf(id)).toBe(0);
    expect(released).toEqual([id]);
  });
});

describe.skipIf(serverUrl === undefined)('the site runner, refusing another task', () => {
  it('refuses a correction on another task than its lease, sending nothing', async () => {
    const detail = detailOf(await w.request(w.ava, requestBody(w.partyA, w.taskA)));
    const id = String(detail['correctionId']);
    await w.approve(w.ben, id, String(detail['versionId']));
    const given = world();
    const { runner } = runnerOn(id, given);

    expect(await runner.pass()).toEqual([{ correctionId: id, outcome: 'NOT_FOUND' }]);
    expect(writes(given.site)).toHaveLength(0);
  });
});

describe.skipIf(serverUrl === undefined)('the site runner, restarted', () => {
  it('a runner restarted on a new connection and lease observes again and never sends twice', async () => {
    const id = await approved();
    const given = world();
    // The deployment is not serving yet, so the first runner leaves it accepted.
    building(given.site);
    const first = runnerOn(id, given);
    expect(await first.runner.pass()).toEqual([{ correctionId: id, outcome: 'following' }]);
    expect(merges(given.site)).toHaveLength(1);

    // The first runner is gone: its lease lapses and a second one takes the task.
    const second = await takeOver();
    const db = connect(String(w.world.db.appUrl));
    try {
      built(given.site);
      const restarted = runnerOn(id, given, db, second);
      expect(await restarted.runner.pass()).toEqual([{ correctionId: id, outcome: 'live' }]);
    } finally {
      await db.close();
      await handBack(second.leaseId);
    }
    expect(merges(given.site)).toHaveLength(1);
    expect(await entries(id)).toHaveLength(1);
    expect(await w.stateOf(id)).toBe('live');
  });
});
