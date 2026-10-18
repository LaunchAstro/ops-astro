// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner (#1692) following an accepted publish, on the site doubles
// and a real database: a deployment still building observed again until live,
// one person task at the ten-minute cap, and a lease lost while following or
// under the run writing no receipt and raising a task.

import { describe, expect, it } from 'vitest';
import { FOLLOW_FOR_MS } from '../../apps/site-runner/runner.ts';
import { approved, expireLease, renewLease, serverUrl, w } from './c80-register-world.ts';
import {
  building,
  built,
  merges,
  runnerOn,
  time,
  useRunnerWorld,
  world,
} from './site-runner-world.ts';

useRunnerWorld();

describe.skipIf(serverUrl === undefined)('the site runner, following', () => {
  it('follows a deployment still building until it serves the change', async () => {
    const id = await approved();
    const given = world();
    building(given.site);
    const { runner } = runnerOn(id, given);

    expect(await runner.pass()).toEqual([{ correctionId: id, outcome: 'following' }]);
    time.clock += 15_000;
    expect(await runner.pass()).toEqual([{ correctionId: id, outcome: 'following' }]);
    built(given.site);
    time.clock += 15_000;
    expect(await runner.pass()).toEqual([{ correctionId: id, outcome: 'live' }]);

    expect(merges(given.site)).toHaveLength(1);
    expect(given.raised).toEqual([]);
    expect(await w.stateOf(id)).toBe('live');
  });

  it('raises one person task at the ten-minute cap and stops following', async () => {
    const id = await approved();
    const given = world();
    building(given.site);
    const { runner, released } = runnerOn(id, given);

    expect(await runner.pass()).toEqual([{ correctionId: id, outcome: 'following' }]);
    time.clock += FOLLOW_FOR_MS - 1;
    expect(await runner.pass()).toEqual([{ correctionId: id, outcome: 'following' }]);
    time.clock += 1;
    expect(await runner.pass()).toEqual([{ correctionId: id, outcome: 'LIVE_CHECK_TIMED_OUT' }]);
    time.clock += 15_000;
    expect(await runner.pass()).toEqual([]);

    expect(given.raised).toEqual(['LIVE_CHECK_TIMED_OUT']);
    expect(released).toEqual([id]);
    expect(merges(given.site)).toHaveLength(1);
  });
});

describe.skipIf(serverUrl === undefined)('the site runner, losing its lease', () => {
  it('a lease lost while following writes no receipt and raises a task', async () => {
    const id = await approved();
    const given = world();
    building(given.site);
    const { runner, lose, released } = runnerOn(id, given);
    expect(await runner.pass()).toEqual([{ correctionId: id, outcome: 'following' }]);
    const receipts = await w.receiptsOf(id);

    lose();
    await expireLease();
    try {
      expect(await runner.pass()).toEqual([{ correctionId: id, outcome: 'LEASE_LOST' }]);
    } finally {
      await renewLease();
    }
    expect(await w.receiptsOf(id)).toBe(receipts);
    expect(given.raised).toEqual(['LEASE_LOST']);
    expect(released).toEqual([id]);
  });

  it('a lease that lapses under the run writes no receipt and raises a task', async () => {
    const id = await approved();
    const given = world();
    building(given.site);
    const { runner } = runnerOn(id, given);
    expect(await runner.pass()).toEqual([{ correctionId: id, outcome: 'following' }]);
    const receipts = await w.receiptsOf(id);

    await expireLease();
    try {
      const [passed] = await runner.pass();
      expect(passed?.outcome).not.toBe('following');
    } finally {
      await renewLease();
    }
    expect(await w.receiptsOf(id)).toBe(receipts);
    expect(given.raised).toContain('LEASE_LOST');
    expect(merges(given.site)).toHaveLength(1);
  });
});
