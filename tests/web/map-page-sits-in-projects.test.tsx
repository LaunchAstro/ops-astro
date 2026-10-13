// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A Wayfinder map is project work: its page sits in the Hub's Projects
// section, so the rail lights Projects on a map's address as it does on a
// task's (MP-2-2, current section lit on every address).

import { describe, expect, it } from 'vitest';
import { open } from './mp-2-1-support.tsx';
import { lit } from './frame-support.tsx';

describe('a map page in the rail', () => {
  it('lights Projects on a map’s address, as on a task’s', async () => {
    const task = await open('/task/TSK-7');
    expect(lit(task.view)).toEqual(['Projects']);
    await task.view.unmount();
    const map = await open('/map/MAP-1');
    expect(lit(map.view)).toEqual(['Projects']);
    await map.view.unmount();
  });
});
