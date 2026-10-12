// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Leaving Complete is `task.reopen` at the revision read, landing in the first
// not-started state, then `task.set_state` at the revision the reopen
// answered. Raced here: two tabs leaving Complete at once, answered in both
// orders; the reopen's answer lost before and after the server stored it; the
// state write's answer lost after the reopen landed; and the retry, which must
// reuse the operation id while the outcome is unknown and mint a new one after
// a refusal.

import { afterEach, describe, expect, it } from 'vitest';
import { StatusField } from '../../apps/web/src/screens/task/StatusField.tsx';
import type { InternalTaskDetail, TaskStateView } from '../../packages/core-wire/src/index.ts';
import type { Mounted } from '../surfaces/mount.tsx';
import { mount, unmountAll } from './perspective-support.tsx';
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

const state = (id: string, machineCategory: string): TaskStateView =>
  ({ id, key: id, label: id, machineCategory }) as TaskStateView;
const STATES = [
  state('s-todo', 'unstarted'),
  state('s-ready', 'unstarted'),
  state('s-doing', 'started'),
  state('s-done', 'completed'),
];

function world() {
  const record = { revision: 4, completed: true, state: 's-done' };
  const api = raceServer((path, body) => {
    if (body['expectedRevision'] !== record.revision) return refused('VERSION_STALE');
    if (path === '/task/reopen') {
      if (!record.completed) return refused('NOT_COMPLETED');
      Object.assign(record, { completed: false, state: 's-todo' });
    } else {
      record.state = String(body['stateId']);
    }
    record.revision += 1;
    return stored(record.revision);
  });
  return { record, ...api };
}

type World = ReturnType<typeof world>;

async function status(api: World) {
  const counted = { changed: 0 };
  const done = task({ state: STATES[3], completedAt: '2026-09-30T10:00:00Z', revision: 4 });
  const view = await mount(
    <StatusField
      client={api.client}
      task={done as unknown as InternalTaskDetail}
      states={STATES}
      id="panel-field-status"
      onChanged={() => (counted.changed += 1)}
    />,
  );
  return { view, counted };
}

// By element, not id: two tabs' selects share one id in this one document.
async function choose(view: Mounted, stateId: string): Promise<void> {
  await view.choose('select', stateId);
  await tick();
  await tick();
}

const paths = (api: World): readonly string[] => api.sent.map((one) => one.path);

describe('two tabs leaving Complete at once', () => {
  it.each(BOTH_ORDERS)(
    'answered %s, the first reopen sets its state and the other is refused, unchanged',
    async (_, x, y) => {
      const api = world();
      const a = await status(api);
      const b = await status(api);
      api.fates.push('hold', 'hold');
      await choose(a.view, 's-doing');
      await choose(b.view, 's-ready');
      await releaseHeld(api.held, x);
      await releaseHeld(api.held, y);
      expect(paths(api)).toStrictEqual(['/task/reopen', '/task/reopen', '/task/set_state']);
      expect(api.record.state).toBe('s-doing');
      expect([a.counted.changed, b.counted.changed]).toStrictEqual([1, 0]);
      expect(b.view.find('[role="alert"]')?.textContent).toContain('VERSION_STALE');
    },
  );
});

describe('a reopen whose answer is lost', () => {
  it('before it reached the server: nothing is counted, and choosing again reopens and sets', async () => {
    const api = world();
    const { view, counted } = await status(api);
    api.fates.push('unreachable');
    await choose(view, 's-doing');
    expect(api.sent).toHaveLength(0);
    expect(counted.changed).toBe(0);
    expect(view.find('[role="alert"]')).not.toBeNull();
    await choose(view, 's-doing');
    expect(paths(api)).toStrictEqual(['/task/reopen', '/task/set_state']);
    expect(api.record.state).toBe('s-doing');
    expect(counted.changed).toBe(1);
  });

  it('after the server stored it: no state write follows and the select is free to retry', async () => {
    const api = world();
    const { view, counted } = await status(api);
    api.fates.push('lose');
    await choose(view, 's-doing');
    expect(paths(api)).toStrictEqual(['/task/reopen']);
    expect(api.record.completed).toBe(false);
    expect(counted.changed).toBe(0);
    expect((view.find('select') as HTMLSelectElement | null)?.disabled).toBe(false);
  });

  it('after the reopen landed, the state write lost: the reopen is still counted', async () => {
    const api = world();
    const { view, counted } = await status(api);
    api.fates.push('answer', 'lose');
    await choose(view, 's-doing');
    expect(paths(api)).toStrictEqual(['/task/reopen', '/task/set_state']);
    expect(counted.changed).toBe(1);
  });
});

describe('a status chosen again', () => {
  it('after a refused reopen is a new operation', async () => {
    const api = world();
    api.record.revision = 5;
    const { view } = await status(api);
    await choose(view, 's-doing');
    expect(view.find('[role="alert"]')?.textContent).toContain('VERSION_STALE');
    await choose(view, 's-doing');
    expect(api.sent).toHaveLength(2);
    expect(idOf(api.sent, 1)).not.toBe(idOf(api.sent, 0));
  });
});
