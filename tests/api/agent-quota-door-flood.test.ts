// SPDX-License-Identifier: AGPL-3.0-only
//
// The door's windows under a flood of keys nobody holds (catalogue #764's
// security review): each made-up key takes a window of its own, so a minute of
// them must cost each new one a constant amount of work, not a pass over every
// window still running, and a lapsed window must still go.

import { describe, expect, it } from 'vitest';
import {
  createAgentQuota,
  DEFAULT_AGENT_LIMITS,
  windowsOf,
  type Window,
} from '../../apps/api/auth/agent-quota.ts';

const FLOOD = 60_000;

describe('the agent door under a flood of unheld keys', () => {
  it('sixty thousand new doors inside one minute take well under a second', () => {
    const quota = createAgentQuota(
      DEFAULT_AGENT_LIMITS,
      () => new Date(0),
      () => 0,
    );
    const started = performance.now();
    for (let key = 0; key < FLOOD; key += 1) quota.knock(`unheld:${key}`);
    // A pass over every live window per new one is about 1.5 billion steps here.
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('a flood that outlasts the window, so old doors keep going, costs each new one the same', () => {
    let at = 0;
    const quota = createAgentQuota(
      DEFAULT_AGENT_LIMITS,
      () => new Date(at),
      () => 0,
    );
    // Eight new keys a millisecond for two minutes: from the second minute on,
    // every new door finds lapsed ones ahead of it.
    for (let key = 0; key < 960_000; key += 1) {
      at = Math.floor(key / 8);
      quota.knock(`unheld:${key}`);
    }
    const started = performance.now();
    for (let key = 960_000; key < 1_000_000; key += 1) {
      at = Math.floor(key / 8);
      quota.knock(`unheld:${key}`);
    }
    expect(performance.now() - started, 'forty thousand more doors').toBeLessThan(500);
  });

  it('a door renewed after its window lapsed keeps its count while older doors go', () => {
    let at = 0;
    const quota = createAgentQuota(
      { ...DEFAULT_AGENT_LIMITS, refused: 1 },
      () => new Date(at),
      () => 0,
    );
    quota.knock('held');
    for (let key = 0; key < 10_001; key += 1) quota.knock(`old:${key}`);
    at = 61_000;
    expect(quota.knock('held'), 'a fresh window after a minute').toBeDefined();
    quota.knock('newer');
    expect(quota.knock('held'), 'its renewed window is full').toBeUndefined();
  });
});

describe('the door windows under a flood of unheld keys', () => {
  it('a flood that outlasts the window keeps only the last minute of doors', () => {
    const windows = new Map<string, Window>();
    const windowOf = windowsOf(windows);
    for (let key = 0; key < 960_000; key += 1) windowOf(`unheld:${key}`, Math.floor(key / 8));
    expect(windows.has('unheld:0'), 'the first door, two minutes old').toBe(false);
    expect(windows.has('unheld:959999'), 'the newest door').toBe(true);
    // The last sweep ran at most a second ago: a minute and a second of doors.
    expect(windows.size).toBeLessThanOrEqual(8 * 61_000);
  });
});
