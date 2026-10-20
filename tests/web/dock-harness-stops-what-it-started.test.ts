// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock harness (dock-harness.ts) stops everything it started, whichever
// step fails: a failed app start still closes the browser it launched, and a
// failed stop still runs the stops after it. The browser, the served app and
// the captures are stand-ins that record each start and stop; the scratch
// folder is the real one, so "removed" is read from the disk.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { onDockSides } from './dock-harness.ts';

const world = vi.hoisted(() => ({
  log: [] as string[],
  scratch: [] as string[],
  fail: new Set<'app start' | 'app stop' | 'browser close'>(),
}));

vi.mock('../support/chromium.ts', () => ({
  launchChromium: () => {
    world.log.push('browser launched');
    return Promise.resolve({
      close: () => {
        world.log.push('browser closed');
        return world.fail.has('browser close')
          ? Promise.reject(new Error('browser close failed'))
          : Promise.resolve();
      },
    });
  },
}));

vi.mock('../visual/app-pages.ts', () => ({
  serveApp: () => {
    if (world.fail.has('app start')) return Promise.reject(new Error('app start failed'));
    world.log.push('app started');
    return Promise.resolve({
      app: new URL('http://127.0.0.1:9/'),
      close: () => {
        world.log.push('app stopped');
        return world.fail.has('app stop')
          ? Promise.reject(new Error('app stop failed'))
          : Promise.resolve();
      },
    });
  },
  madeUpSession: (_app: URL, dir: string) => {
    world.scratch.push(dir);
    return join(dir, 'session.json');
  },
}));

vi.mock('../visual/packet.ts', () => ({
  MODE: {},
  readPacket: () => ({}),
  readAssets: () => [],
  fetchAssets: () => Promise.resolve(),
}));

vi.mock('../visual/capture.ts', () => ({
  openSide: () =>
    Promise.resolve({
      context: {
        close: () => {
          world.log.push('side closed');
          return Promise.resolve();
        },
      },
    }),
}));

beforeEach(() => {
  world.log = [];
  world.scratch = [];
  world.fail.clear();
});

const run = () => onDockSides([390], ['light'], () => Promise.resolve());

it('a failed app start closes the browser already launched', async () => {
  world.fail.add('app start');
  await expect(run()).rejects.toThrow('app start failed');
  expect(world.log).toEqual(['browser launched', 'browser closed']);
});

it('a failed browser close still stops the app and removes the scratch folder', async () => {
  world.fail.add('browser close');
  await expect(run()).rejects.toThrow('browser close failed');
  expect(world.log).toContain('app stopped');
  expect(world.scratch).toHaveLength(1);
  expect(world.scratch.filter((dir) => existsSync(dir))).toEqual([]);
});

it('a failed app stop still closes the browser and removes the scratch folder', async () => {
  world.fail.add('app stop');
  await expect(run()).rejects.toThrow('app stop failed');
  expect(world.log).toContain('browser closed');
  expect(world.scratch).toHaveLength(1);
  expect(world.scratch.filter((dir) => existsSync(dir))).toEqual([]);
});

it('a run with no failure stops the side, the app and the browser it started', async () => {
  await run();
  expect(world.log.toSorted()).toEqual(
    ['browser closed', 'browser launched', 'app started', 'app stopped', 'side closed'].toSorted(),
  );
  expect(world.scratch).toHaveLength(1);
  expect(world.scratch.filter((dir) => existsSync(dir))).toEqual([]);
});
