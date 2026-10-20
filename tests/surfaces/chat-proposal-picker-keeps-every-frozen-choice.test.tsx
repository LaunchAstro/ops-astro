// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// #1666, review S1861-1: a reply's frozen choice is never pushed out of the
// tab by later clicks, so a reload of an older card still sends the payload
// its first click sent, under the same operation id. A choice the tab cannot
// keep is not sent at all. The recorder stands in for the network only.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickedTarget, targetsOf } from '../../apps/web/src/assistant/targets.ts';
import { block, drawer, GRANT } from './chat-proposal-drawer.tsx';
import {
  EDIT_REPLY,
  editing,
  FIRST,
  landed,
  pick,
  READS,
  RENAME,
  SECOND,
  TWO,
  update,
} from './chat-proposal-picker.tsx';
import { track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(() => {
  vi.restoreAllMocks();
  unmountAll();
});

describe('chat proposal picker keeps every frozen choice', () => {
  it('a reload sends the reply’s first payload after 32 later choices in the tab', async () => {
    const live = await drawer({
      replies: [editing(TWO)],
      tasks: READS,
      writes: [{ unavailable: true, because: 'The network dropped.' }],
    });
    await live.ask('Rename the second');
    await landed();
    await pick(live.page, SECOND);
    await live.click();
    expect(live.writes()).toStrictEqual([update(SECOND, 5)]);
    await live.page.unmount();
    // Each later card's click freezes its own choice in the same tab.
    const other = targetsOf(TWO);
    if (other === null) throw new Error('targets refused');
    for (let at = 0; at < 32; at += 1) {
      pickedTarget(GRANT, randomUUID(), { ...other, chosen: FIRST });
    }
    const reloaded = await drawer({
      kept: { body: block(RENAME), scope: null, messageId: EDIT_REPLY, targets: TWO },
      tasks: READS,
    });
    track(reloaded.page);
    await landed();
    await pick(reloaded.page, FIRST);
    await reloaded.click();
    expect(reloaded.writes()).toStrictEqual([update(SECOND, 5)]);
  });

  it('a choice the tab cannot keep is not sent', async () => {
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith('ops-astro:proposal-choices:')) throw new Error('QuotaExceededError');
      setItem.call(this, key, value);
    });
    const live = await drawer({ replies: [editing(TWO)], tasks: READS });
    track(live.page);
    await live.ask('Rename the second');
    await landed();
    await pick(live.page, SECOND);
    await live.click();
    expect(live.writes()).toStrictEqual([]);
    expect(live.page.find('[data-proposal="refusal"]')?.textContent).toMatch(/not applied/u);
  });
});
