// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The panel rename writes the typed name at the revision the rename opened at,
// and a name not stored is kept for the next Rename. Raced here: two tabs
// renaming at once, answered in both orders; the answer lost before and after
// the server stored it, and after the panel left; and the retry, which must
// reuse the operation id while the outcome is unknown and mint a new one after
// a refusal.

import { afterEach, describe, expect, it } from 'vitest';
import { PanelName } from '../../apps/web/src/screens/task/PanelFields.tsx';
import type { InternalTaskDetail } from '../../packages/core-wire/src/index.ts';
import type { Mounted } from '../surfaces/mount.tsx';
import { mount, press, typeInto, unmountAll } from './perspective-support.tsx';
import { task, tick } from './task-page-stub.tsx';
import {
  BOTH_ORDERS,
  idOf,
  raceServer,
  refused,
  releaseHeld,
  stored,
} from './write-race-support.tsx';

afterEach(unmountAll);

function world() {
  const record = { revision: 4, title: 'Original' };
  const api = raceServer((_path, body) => {
    if (body['expectedRevision'] !== record.revision) return refused('VERSION_STALE');
    record.revision += 1;
    record.title = String((body['fields'] as { title: unknown }).title);
    return stored(record.revision);
  });
  return { record, ...api };
}

type World = ReturnType<typeof world>;

async function panelName(api: World) {
  const counted = { changed: 0 };
  const shown = task({ title: 'Original', revision: 4 }) as unknown as InternalTaskDetail;
  const view = await mount(
    <PanelName client={api.client} task={shown} onChanged={() => (counted.changed += 1)} />,
  );
  return { view, counted };
}

async function rename(view: Mounted, name: string): Promise<void> {
  await view.click('[data-panel-field="name"]');
  await typeInto(view, '#panel-field-name', name);
  await press(view, '#panel-field-name', 'Enter');
  await tick();
}

/** Rename again with what the box reopens with, and say what that was. */
async function renameAgain(view: Mounted): Promise<string | undefined> {
  await view.click('[data-panel-field="name"]');
  const reopened = (view.find('#panel-field-name') as HTMLInputElement | null)?.value;
  await press(view, '#panel-field-name', 'Enter');
  await tick();
  return reopened;
}

describe('two tabs renaming one task at once', () => {
  it.each(BOTH_ORDERS)(
    'answered %s, the first to arrive is stored and the other is refused with its name kept',
    async (_, x, y) => {
      const api = world();
      const a = await panelName(api);
      const b = await panelName(api);
      api.fates.push('hold', 'hold');
      await rename(a.view, 'From A');
      await rename(b.view, 'From B');
      await releaseHeld(api.held, x);
      await releaseHeld(api.held, y);
      expect(api.record.title).toBe('From A');
      expect([a.counted.changed, b.counted.changed]).toStrictEqual([1, 0]);
      expect(b.view.find('[role="alert"]')?.textContent).toContain('VERSION_STALE');
      await b.view.click('[data-panel-field="name"]');
      expect((b.view.find('#panel-field-name') as HTMLInputElement | null)?.value).toBe('From B');
    },
  );
});

describe('a rename whose answer is lost', () => {
  it('before it reached the server: Rename reopens with the name and sends it', async () => {
    const api = world();
    const { view, counted } = await panelName(api);
    api.fates.push('unreachable');
    await rename(view, 'New name');
    expect(api.sent).toHaveLength(0);
    expect(await renameAgain(view)).toBe('New name');
    expect(api.record.title).toBe('New name');
    expect(counted.changed).toBe(1);
  });

  it('after the server stored it: Rename reopens with the name, nothing counted yet', async () => {
    const api = world();
    const { view, counted } = await panelName(api);
    api.fates.push('lose');
    await rename(view, 'New name');
    expect(api.record.title).toBe('New name');
    expect(counted.changed).toBe(0);
    await view.click('[data-panel-field="name"]');
    expect((view.find('#panel-field-name') as HTMLInputElement | null)?.value).toBe('New name');
  });

  it('answered after the panel left: the stored rename is still counted', async () => {
    const api = world();
    const { view, counted } = await panelName(api);
    api.fates.push('hold');
    await rename(view, 'New name');
    await view.unmount();
    await releaseHeld(api.held, 0);
    expect(counted.changed).toBe(1);
  });
});

describe('a rename pressed again', () => {
  it('after a refusal is a new operation', async () => {
    const api = world();
    api.record.revision = 5;
    const { view } = await panelName(api);
    await rename(view, 'New name');
    expect(view.find('[role="alert"]')?.textContent).toContain('VERSION_STALE');
    await renameAgain(view);
    expect(api.sent).toHaveLength(2);
    expect(idOf(api.sent, 1)).not.toBe(idOf(api.sent, 0));
  });

  it('after the server stored it with the answer lost is the same operation, answered as stored', async () => {
    const api = world();
    const { view, counted } = await panelName(api);
    api.fates.push('lose');
    await rename(view, 'New name');
    expect(await renameAgain(view)).toBe('New name');
    expect(idOf(api.sent, 1)).toBe(idOf(api.sent, 0));
    expect(view.find('[role="alert"]')).toBeNull();
    expect(counted.changed).toBe(1);
  });
});
