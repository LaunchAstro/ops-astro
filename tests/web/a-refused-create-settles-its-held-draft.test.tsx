// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A Create refused while its draft is held: the draft is not removed. The
// answered id is settled when the browser can rewrite the copy; when it
// cannot, a reload retries that id, the register replays the refusal, and the
// person may stop waiting.

import { describe, expect, it } from 'vitest';
import { dropOtherDrafts } from '../../apps/web/src/screens/task/task-draft.ts';
import { store } from './draft-support.tsx';
import { settle } from '../surfaces/mount.tsx';
import {
  createLabel,
  DRAFT_KEY,
  FIRST_ID,
  heldId,
  openDraft,
  pressCreate,
  refuseRemoval,
  release,
  server,
} from './draft-removal-refused-support.tsx';

describe('a refused Create', () => {
  it('leaves no held id when the draft cannot be removed, so the next Create is new', async () => {
    const storage = store();
    const api = server();
    const { view } = await openDraft(api, storage);
    await view.type('#panel-draft-name', 'Renew the domain');
    refuseRemoval(storage);
    api.next.refuse = true;
    await pressCreate(view);
    expect(createLabel(view)).toBe('Create task');
    expect(heldId(storage)).toBeNull();
    await pressCreate(view);
    expect(api.creates).toHaveLength(2);
    expect(api.creates[1]).not.toBe(FIRST_ID);
    await view.unmount();
  });
});

describe('a refused Create settled while storage would not write', () => {
  it('keeps the words, and its Retry replays the refusal under its id', async () => {
    const storage = store();
    const api = server();
    const { view } = await openDraft(api, storage);
    await view.type('#panel-draft-name', 'Renew the domain');
    api.next.refuse = true;
    api.next.hold = true;
    await view.click('[data-draft="create"]');
    const setItem = storage.setItem.bind(storage);
    storage.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    await release(api, 0);
    expect(createLabel(view)).toBe('Create task');
    storage.setItem = setItem;
    await view.unmount();
    // A reload: the tab's memory is gone, its storage is not.
    dropOtherDrafts(null, null);
    api.next.hold = false;
    const reloaded = await openDraft(api, storage);
    expect((reloaded.view.find('#panel-draft-name') as HTMLInputElement).value).toBe(
      'Renew the domain',
    );
    // The answered id could not be cleared, so the reload offers it once more.
    expect(createLabel(reloaded.view)).toBe('Retry Create');
    const first = api.creates[0];
    await reloaded.view.click('[data-draft="create"]');
    await settle();
    await settle();
    expect(api.creates).toEqual([first, first]);
    expect(api.tasks).toEqual([]);
    expect(heldId(storage)).toBe(first);
    expect(reloaded.view.find('[data-draft="let-go"]')).not.toBeNull();
    await reloaded.view.unmount();
  });
});

describe('a refused Create settled while storage would not write, in the same tab', () => {
  it('Create again is a new operation', async () => {
    const storage = store();
    const api = server();
    const { view } = await openDraft(api, storage);
    await view.type('#panel-draft-name', 'Renew the domain');
    api.next.refuse = true;
    api.next.hold = true;
    await view.click('[data-draft="create"]');
    const setItem = storage.setItem.bind(storage);
    storage.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    await release(api, 0);
    storage.setItem = setItem;
    api.next.hold = false;
    expect(createLabel(view)).toBe('Create task');
    await pressCreate(view);
    expect(api.creates).toHaveLength(2);
    expect(api.creates[1]).not.toBe(api.creates[0]);
    expect(api.tasks).toStrictEqual([api.creates[1]]);
    expect(storage.getItem(DRAFT_KEY)).toBeNull();
    await view.unmount();
  });
});
