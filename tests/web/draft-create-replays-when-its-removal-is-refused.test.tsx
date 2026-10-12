// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A Create that made its task drops the draft; a draft the browser would not
// remove keeps its create's id, so the reopened draft replays that task rather
// than making a second. Raced here: two tabs retrying one held Create, the
// answer lost before and after the server stored it, the answer landing on a
// remounted panel, and a refusal, which must leave no id held. The server
// replays a create by its operation id, as the real register does.

import { describe, expect, it } from 'vitest';
import { store } from './draft-support.tsx';
import {
  createLabel,
  duplicate,
  DRAFT_KEY,
  FIRST_ID,
  heldId,
  openDraft,
  pressCreate,
  refuseRemoval,
  release,
  reopenAndRetry,
  sameHost,
  server,
  storedAnswerLost,
} from './draft-removal-refused-support.tsx';

describe('two tabs retrying one held Create, the removal refused in one', () => {
  it.each([
    ['in the order sent', 0, 1],
    ['in the reverse order', 1, 0],
  ])(
    'answered %s, make one task and the tab that could not drop it keeps the id',
    async (_, x, y) => {
      const one = store();
      const api = server();
      await storedAnswerLost(api, one);
      const two = duplicate(one);
      refuseRemoval(one);
      const a = await openDraft(api, one);
      const b = await openDraft(api, two);
      api.next.hold = true;
      await a.view.click('[data-draft="create"]');
      await b.view.click('[data-draft="create"]');
      expect(api.held).toHaveLength(2);
      await release(api, x);
      await release(api, y);
      expect(new Set(api.creates)).toStrictEqual(new Set([FIRST_ID]));
      expect(api.tasks).toHaveLength(1);
      expect([a.opened.created, b.opened.created]).toStrictEqual(['TSK-1', 'TSK-1']);
      expect(heldId(one)).toBe(FIRST_ID);
      expect(two.getItem(DRAFT_KEY)).toBeNull();
    },
  );
});

describe('a held Create whose answer is lost, then created with the removal refused', () => {
  it('lost before it reached the server: the retry sends the same id and keeps it', async () => {
    const storage = store();
    const api = server();
    const { view, opened } = await openDraft(api, storage);
    await view.type('#panel-draft-name', 'Renew the domain');
    api.next.unreachable = true;
    await pressCreate(view);
    expect(createLabel(view)).toBe('Retry Create');
    refuseRemoval(storage);
    await pressCreate(view);
    expect(opened.created).toBe('TSK-1');
    expect(api.creates).toStrictEqual([FIRST_ID]);
    expect(heldId(storage)).toBe(FIRST_ID);
    await view.unmount();
  });

  it('lost after the server stored it: every reopen replays the one task', async () => {
    const storage = store();
    const api = server();
    await storedAnswerLost(api, storage);
    refuseRemoval(storage);
    expect(await reopenAndRetry(api, storage)).toBe('TSK-1');
    expect(await reopenAndRetry(api, storage)).toBe('TSK-1');
    expect(api.creates).toStrictEqual([FIRST_ID, FIRST_ID, FIRST_ID]);
    expect(api.tasks).toHaveLength(1);
  });
});

describe('a created answer that lands on a remounted panel, the removal refused', () => {
  it('leaves the new mount holding the same id for Retry', async () => {
    const storage = store();
    const api = server();
    const first = await openDraft(api, storage, sameHost);
    await first.view.type('#panel-draft-name', 'Renew the domain');
    refuseRemoval(storage);
    api.next.hold = true;
    await first.view.click('[data-draft="create"]');
    await first.view.unmount();
    const second = await openDraft(api, storage, sameHost);
    expect((second.view.find('[data-draft="create"]') as HTMLButtonElement | null)?.disabled).toBe(
      true,
    );
    await release(api, 0);
    expect(first.opened.created).toBe('TSK-1');
    expect(createLabel(second.view)).toBe('Retry Create');
    api.next.hold = false;
    await pressCreate(second.view);
    expect(second.opened.created).toBe('TSK-1');
    expect(api.creates).toStrictEqual([FIRST_ID, FIRST_ID]);
    expect(api.tasks).toHaveLength(1);
    await second.view.unmount();
  });
});
